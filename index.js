require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.API_KEY;
const chatId = "1633310404";

const bot = new TelegramBot(token, {
    polling: {
        autoStart: false,
        params: { timeout: 10 }
    }
});

// Forcer l'arrêt de toute instance précédente avant de démarrer
bot.stopPolling().then(() => {
    setTimeout(() => {
        bot.startPolling();
        console.log("✅ Polling démarré proprement");
    }, 3000);
}).catch(() => {
    setTimeout(() => {
        bot.startPolling();
        console.log("✅ Polling démarré");
    }, 3000);
});

console.log("🔥 BOT FINAL LANCÉ");

// ============================================================
// 💾 SAUVEGARDE / CHARGEMENT
// ============================================================

const DATA_FILE = 'botdata.json';

function saveData() {
    const data = {
        minShots, minOnTarget, minPossession, minXG,
        minXG_live, minPoss_live, minShots_live,
        results, resultsLive,
        sentMatches, sentMatchesLive,
        leagueStats, modePrudent, bankroll,
        // Nouveaux — paris en attente de validation
        pendingValidation
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            minShots = data.minShots ?? 5;
            minOnTarget = data.minOnTarget ?? 2;
            minPossession = data.minPossession ?? 51;
            minXG = data.minXG ?? 0.5;
            minXG_live = data.minXG_live ?? 0.6;
            minPoss_live = data.minPoss_live ?? 52;
            minShots_live = data.minShots_live ?? 4;
            results = data.results ?? [];
            resultsLive = data.resultsLive ?? [];
            sentMatches = data.sentMatches ?? [];
            sentMatchesLive = data.sentMatchesLive ?? [];
            leagueStats = data.leagueStats ?? {};
            modePrudent = data.modePrudent ?? false;
            bankroll = data.bankroll ?? 100;
            pendingValidation = data.pendingValidation ?? {};
            console.log("💾 Données chargées depuis botdata.json");
        }
    } catch (err) {
        console.log("Erreur chargement données:", err.message);
    }
}

// 🔒 Variables globales
let sentMatches = [];
let sentMatchesLive = [];
let pendingBets = [];
let results = [];
let resultsLive = [];
let leagueStats = {};
let modePrudent = false;
let bankroll = 100;

// 🆕 Paris en attente de ta validation { fixtureId: { matchData, signalData } }
let pendingValidation = {};

// 🎯 Paramètres adaptatifs
let minShots = 5;
let minOnTarget = 2;
let minPossession = 51;
let minXG = 0.5;
let minXG_live = 0.6;
let minPoss_live = 52;
let minShots_live = 4;

loadData();

// 🏆 GRANDES LIGUES
const GRANDES_LIGUES = [
    "Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1",
    "Eredivisie", "Primeira Liga", "Champions League", "Europa League",
    "Conference League", "Championship", "Serie B", "2. Bundesliga",
    "Ligue 2", "La Liga2"
];

function estGrandeLigue(leagueName) {
    return GRANDES_LIGUES.some(l =>
        leagueName.toLowerCase().includes(l.toLowerCase())
    );
}

// ============================================================
// 💰 BANKROLL + MODE PRUDENT
// ============================================================

function getMiseOptimale() {
    const derniers = results.slice(-10);
    if (derniers.length < 3) return 1;
    const wins = derniers.filter(r => r.win).length;
    const tauxRecent = wins / derniers.length;
    if (modePrudent) return 0.5;
    if (tauxRecent >= 0.8) return 3;
    if (tauxRecent >= 0.65) return 2;
    if (tauxRecent >= 0.5) return 1;
    return 0.5;
}

function verifierSeriePerdante() {
    const derniers = results.slice(-3);
    if (derniers.length < 3) return;
    const tousPerdu = derniers.every(r => !r.win);
    if (tousPerdu && !modePrudent) {
        modePrudent = true;
        saveData();
        bot.sendMessage(chatId,
            `⚠️ *ALERTE MODE PRUDENT ACTIVÉ*\n\n3 paris perdants consécutifs.\n🛡️ Mises réduites à 0.5% bankroll.\nTape /modeprudent off pour désactiver.`,
            { parse_mode: "Markdown" }
        );
    }
    const deuxDerniers = results.slice(-2);
    if (deuxDerniers.length === 2 && deuxDerniers.every(r => r.win) && modePrudent) {
        modePrudent = false;
        saveData();
        bot.sendMessage(chatId, `✅ *MODE PRUDENT DÉSACTIVÉ* — 2 wins consécutifs ! 🔥`, { parse_mode: "Markdown" });
    }
}

function updateLeagueStats(league, win) {
    if (!leagueStats[league]) leagueStats[league] = { wins: 0, total: 0 };
    leagueStats[league].total++;
    if (win) leagueStats[league].wins++;
    saveData();
}

function getLeagueScore(league) {
    const stats = leagueStats[league];
    if (!stats || stats.total < 3) return null;
    return stats.wins / stats.total;
}

// ============================================================
// 🧠 CONSEIL PERSONNALISÉ basé sur l'historique
// ============================================================

function getConseil(signal, league, homePoss, homeXG, homeShots) {
    const conseils = [];
    let scoreConseil = 0;

    // 1. Analyse de la ligue
    const leagueScore = getLeagueScore(league);
    if (leagueScore !== null) {
        if (leagueScore >= 0.75) {
            conseils.push(`⭐ Ligue rentable (${Math.round(leagueScore * 100)}% de réussite historique)`);
            scoreConseil += 30;
        } else if (leagueScore >= 0.5) {
            conseils.push(`✅ Ligue correcte (${Math.round(leagueScore * 100)}% de réussite)`);
            scoreConseil += 15;
        } else if (leagueScore < 0.4) {
            conseils.push(`⚠️ Ligue peu rentable (${Math.round(leagueScore * 100)}% seulement)`);
            scoreConseil -= 20;
        }
    } else {
        conseils.push(`📊 Ligue sans historique suffisant`);
    }

    // 2. Analyse des stats par rapport aux moyennes gagnantes
    const winsHistorique = results.filter(r => r.win);
    if (winsHistorique.length >= 5) {
        const avgWinXG = winsHistorique.reduce((a, b) => a + b.homeXG, 0) / winsHistorique.length;
        const avgWinPoss = winsHistorique.reduce((a, b) => a + b.homePoss, 0) / winsHistorique.length;
        const avgWinShots = winsHistorique.reduce((a, b) => a + b.homeShots, 0) / winsHistorique.length;

        if (homeXG >= avgWinXG) {
            conseils.push(`🎯 xG (${homeXG}) au dessus de ta moyenne gagnante (${avgWinXG.toFixed(1)})`);
            scoreConseil += 25;
        } else {
            conseils.push(`📉 xG (${homeXG}) en dessous de ta moyenne gagnante (${avgWinXG.toFixed(1)})`);
            scoreConseil -= 10;
        }

        if (homePoss >= avgWinPoss) {
            scoreConseil += 20;
        }
        if (homeShots >= avgWinShots) {
            scoreConseil += 15;
        }
    }

    // 3. Mode prudent
    if (modePrudent) {
        conseils.push(`🛡️ Mode prudent actif — mise réduite recommandée`);
        scoreConseil -= 15;
    }

    // 4. Taux de réussite récent global
    const derniers5 = results.slice(-5);
    if (derniers5.length >= 3) {
        const tauxRecent = derniers5.filter(r => r.win).length / derniers5.length;
        if (tauxRecent >= 0.6) {
            conseils.push(`📈 Bonne forme récente (${Math.round(tauxRecent * 100)}% sur 5 derniers)`);
            scoreConseil += 20;
        } else if (tauxRecent < 0.4) {
            conseils.push(`📉 Forme récente faible (${Math.round(tauxRecent * 100)}% sur 5 derniers)`);
            scoreConseil -= 15;
        }
    }

    // 5. Type de signal
    if (signal === "perfect") scoreConseil += 20;
    else if (signal === "next_goal") scoreConseil += 10;

    // Recommandation finale
    let recommandation;
    if (scoreConseil >= 60) {
        recommandation = "🟢 *BOT RECOMMANDE : PRENDRE*";
    } else if (scoreConseil >= 30) {
        recommandation = "🟡 *BOT RECOMMANDE : À TON APPRÉCIATION*";
    } else {
        recommandation = "🔴 *BOT RECOMMANDE : PRUDENCE*";
    }

    return { conseils, recommandation, scoreConseil };
}

// ============================================================
// 🔥 API MATCHS LIVE
// ============================================================

async function getMatches() {
    try {
        const response = await axios.get(
            'https://v3.football.api-sports.io/fixtures?live=all',
            { headers: { 'x-apisports-key': apiKey } }
        );
        return response.data.response;
    } catch (err) {
        console.log("Erreur API :", err.message);
        return [];
    }
}

// ============================================================
// 🧠 ANALYSE MI-TEMPS — envoie les données + boutons OUI/NON
// ============================================================

function analyseMatch(match) {
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const homeGoals = match.goals.home;
    const awayGoals = match.goals.away;
    const league = match.league.name;
    const fixtureId = match.fixture.id;

    const stats = match.statistics;
    if (!stats) return null;

    const homeStats = stats.find(t => t.team.name === home);
    const awayStats = stats.find(t => t.team.name === away);
    if (!homeStats || !awayStats) return null;

    const getStat = (team, type) =>
        team.statistics.find(s => s.type === type)?.value || 0;

    const homeShots = getStat(homeStats, "Total Shots");
    const homeOnTarget = getStat(homeStats, "Shots on Goal");
    const homePoss = parseInt(getStat(homeStats, "Ball Possession"));
    const homeXG = parseFloat(getStat(homeStats, "Expected Goals")) || 0;

    const seuilPoss = modePrudent ? minPossession + 5 : minPossession;
    const seuilXG = modePrudent ? minXG + 0.2 : minXG;
    const seuilShots = modePrudent ? minShots + 2 : minShots;

    let score = 0;
    if (homePoss > seuilPoss) score += 25;
    if (homeShots >= seuilShots) score += 25;
    if (homeOnTarget >= minOnTarget) score += 25;
    if (homeXG >= seuilXG) score += 25;

    // Déterminer le niveau du signal
    let signalType = null;
    let signalLabel = "";

    if (homePoss >= 62 && homeShots >= 10 && homeOnTarget >= 5 && homeXG >= 1.5 && homeGoals <= awayGoals) {
        signalType = "perfect";
        signalLabel = "🟢🟢 MATCH PARFAIT";
    } else if (homePoss > 60 && homeShots >= 8 && homeOnTarget >= 4 && homeXG >= 1.2 && homeGoals <= awayGoals) {
        signalType = "next_goal";
        signalLabel = "🚨 SIGNAL PREMIUM";
    } else if (homeGoals <= awayGoals && score >= 75) {
        signalType = "over";
        signalLabel = "🔥 VALUE BET";
    }

    if (!signalType) return null;

    const mise = getMiseOptimale();
    const { conseils, recommandation, scoreConseil } = getConseil(signalType, league, homePoss, homeXG, homeShots);

    // Construction du message
    let msg = `🏆 ${league}\n\n`;
    msg += `${signalLabel}\n\n`;
    msg += `⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n`;
    msg += `⏱️ MI-TEMPS\n\n`;
    msg += `📊 *Stats ${home}:*\n`;
    msg += `👉 Possession: ${homePoss}%\n`;
    msg += `👉 Tirs totaux: ${homeShots}\n`;
    msg += `👉 Tirs cadrés: ${homeOnTarget}\n`;
    msg += `👉 xG: ${homeXG}\n\n`;
    msg += `🎯 *Analyse bot:*\n`;
    conseils.forEach(c => { msg += `${c}\n`; });
    msg += `\n${recommandation}\n\n`;
    msg += `💰 Mise suggérée: ${mise}% (≈ ${(bankroll * mise / 100).toFixed(2)}€)\n\n`;
    msg += `👇 *Tu prends ce pari ?*`;

    return {
        message: msg,
        signalType,
        fixtureId,
        league,
        scoreConseil,
        data: { homeShots, homeOnTarget, homePoss, homeXG, home, away, homeGoals, awayGoals }
    };
}

// ============================================================
// 🔬 SIGNAL XG AVANCÉ — Différentiel + Frustration + Combo
// ============================================================

function analyseXGAvance(match) {
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const homeGoals = match.goals.home;
    const awayGoals = match.goals.away;
    const league = match.league.name;
    const fixtureId = match.fixture.id;

    const stats = match.statistics;
    if (!stats) return null;

    const homeStats = stats.find(t => t.team.name === home);
    const awayStats = stats.find(t => t.team.name === away);
    if (!homeStats || !awayStats) return null;

    const getStat = (team, type) =>
        team.statistics.find(s => s.type === type)?.value || 0;

    const homeXG = parseFloat(getStat(homeStats, "Expected Goals")) || 0;
    const awayXG = parseFloat(getStat(awayStats, "Expected Goals")) || 0;
    const homePoss = parseInt(getStat(homeStats, "Ball Possession"));
    const homeShots = getStat(homeStats, "Total Shots");
    const homeOnTarget = getStat(homeStats, "Shots on Goal");

    // ── Calculs clés ──
    const xgDiff = homeXG - awayXG;               // Différentiel xG
    const xgRatio = awayXG > 0 ? homeXG / awayXG : homeXG * 10; // Ratio domicile/extérieur
    const xgFrustration = homeXG >= 1.0 && homeGoals === 0;      // xG élevé mais 0 but
    const domination = homePoss >= 58 && homeOnTarget >= 4 && homeXG >= 1.0;

    // ── Scoring ──
    let score = 0;
    let signaux = [];
    let typeSignal = null;

    // 1. FRUSTRATION xG — équipe qui aurait dû marquer
    if (xgFrustration) {
        score += 40;
        signaux.push(`😤 Frustration xG: ${homeXG} xG pour 0 but — retour statistique probable`);
    }

    // 2. DIFFÉRENTIEL xG fort
    if (xgDiff >= 0.8) {
        score += 30;
        signaux.push(`📈 Différentiel xG: +${xgDiff.toFixed(2)} en faveur de ${home}`);
    } else if (xgDiff >= 0.5) {
        score += 15;
        signaux.push(`📊 Différentiel xG: +${xgDiff.toFixed(2)} en faveur de ${home}`);
    }

    // 3. RATIO xG — domicile domine clairement
    if (xgRatio >= 2) {
        score += 25;
        signaux.push(`⚡ Ratio xG x${xgRatio.toFixed(1)}: domination écrasante de ${home}`);
    }

    // 4. COMBO xG + possession + cadrés
    if (domination) {
        score += 25;
        signaux.push(`🎯 Combo parfait: xG ${homeXG} + Poss ${homePoss}% + ${homeOnTarget} cadrés`);
    }

    // 5. CONTEXTE SCORE — équipe qui pousse car derrière ou à égalité
    if (homeGoals <= awayGoals && xgDiff > 0) {
        score += 15;
        signaux.push(`🔥 Contexte score: ${home} pousse (${homeGoals}-${awayGoals})`);
    }

    // 6. PIÈGE — équipe qui mène confortablement → moins de motivation
    if (homeGoals >= 2 && homeGoals > awayGoals) {
        score -= 30;
        signaux.push(`⚠️ Attention: ${home} mène déjà ${homeGoals}-${awayGoals} → risque de relâchement`);
    }

    // Seuil minimum pour envoyer un signal
    if (score < 55) return null;

    // Niveau du signal
    let niveau = "";
    if (score >= 90) {
        niveau = "🔬🔬 XG ELITE 🔬🔬";
        typeSignal = "xg_elite";
    } else if (score >= 75) {
        niveau = "🔬 XG PREMIUM 🔬";
        typeSignal = "xg_premium";
    } else {
        niveau = "📊 XG SIGNAL 📊";
        typeSignal = "xg_signal";
    }

    const mise = getMiseOptimale();
    const { recommandation } = getConseil(typeSignal, league, homePoss, homeXG, homeShots);

    let msg = `🏆 ${league}\n\n`;
    msg += `${niveau}\n\n`;
    msg += `⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n`;
    msg += `⏱️ MI-TEMPS\n\n`;
    msg += `🔬 *Analyse xG avancée:*\n`;
    msg += `👉 xG ${home}: *${homeXG}*\n`;
    msg += `👉 xG ${away}: *${awayXG}*\n`;
    msg += `👉 Différentiel: *+${xgDiff.toFixed(2)}*\n`;
    msg += `👉 Ratio: *x${xgRatio.toFixed(1)}*\n\n`;
    msg += `📊 *Signaux détectés:*\n`;
    signaux.forEach(s => { msg += `${s}\n`; });
    msg += `\n${recommandation}\n`;
    msg += `💡 Score de confiance: *${Math.min(score, 99)}%*\n`;
    msg += `💰 Mise suggérée: ${mise}% (≈ ${(bankroll * mise / 100).toFixed(2)}€)\n\n`;
    msg += `🎯 *PARI: But de ${home}*\n\n`;
    msg += `👇 *Tu prends ce pari ?*`;

    return {
        message: msg,
        signalType: typeSignal,
        fixtureId,
        league,
        scoreConseil: score,
        data: { homeShots, homeOnTarget, homePoss, homeXG, awayXG, xgDiff, home, away, homeGoals, awayGoals }
    };
}

// ============================================================
// 📨 ENVOI SIGNAL AVEC BOUTONS OUI / NON
// ============================================================

function envoyerSignalAvecBoutons(result) {
    const keyboard = {
        inline_keyboard: [[
            { text: "✅ OUI je prends", callback_data: `pari_oui_${result.fixtureId}` },
            { text: "❌ NON je passe", callback_data: `pari_non_${result.fixtureId}` }
        ]]
    };

    bot.sendMessage(chatId, result.message, {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });

    // Sauvegarder en attente de validation
    pendingValidation[result.fixtureId] = {
        signalType: result.signalType,
        league: result.league,
        timestamp: Date.now(),
        data: result.data,
        decision: null
    };
    saveData();
}

// ============================================================
// 🎮 GESTION DES BOUTONS OUI / NON
// ============================================================

bot.on('callback_query', async (query) => {
    if (String(query.message.chat.id) !== String(chatId)) return;
    const data = query.data;
    bot.answerCallbackQuery(query.id);

    // ✅ L'utilisateur prend le pari
    if (data.startsWith('pari_oui_')) {
        const fixtureId = parseInt(data.replace('pari_oui_', ''));
        const pv = pendingValidation[fixtureId];
        if (!pv) return;

        pv.decision = 'oui';
        saveData();

        // Enregistrer dans pendingBets pour suivre le résultat
        pendingBets.push({
            fixtureId,
            type: pv.signalType,
            league: pv.league,
            timestamp: Date.now(),
            prisParUtilisateur: true,
            ...pv.data,
            checked: false
        });

        const mise = getMiseOptimale();
        bot.sendMessage(chatId,
            `✅ *Pari enregistré !*\n\n` +
            `⚽ ${pv.data.home} vs ${pv.data.away}\n` +
            `💰 Mise: ${mise}% (≈ ${(bankroll * mise / 100).toFixed(2)}€)\n\n` +
            `Je te donnerai le résultat en fin de match. Bonne chance ! 🍀`,
            { parse_mode: "Markdown" }
        );
    }

    // ❌ L'utilisateur passe
    else if (data.startsWith('pari_non_')) {
        const fixtureId = parseInt(data.replace('pari_non_', ''));
        const pv = pendingValidation[fixtureId];
        if (!pv) return;

        pv.decision = 'non';
        saveData();

        // On enregistre quand même pour apprendre — le bot suivra le résultat
        pendingBets.push({
            fixtureId,
            type: pv.signalType,
            league: pv.league,
            timestamp: Date.now(),
            prisParUtilisateur: false,
            ...pv.data,
            checked: false
        });

        bot.sendMessage(chatId,
            `❌ *Pari refusé — je continue à surveiller.*\n\nJe te dirai quand même ce qu'il se passe en fin de match pour que l'on apprenne ensemble. 📊`,
            { parse_mode: "Markdown" }
        );
    }

    // ═══════════════════════════════
    // MENU PRINCIPAL
    // ═══════════════════════════════

    else if (data === "menu_stats") {
        const prisParMoi = results.filter(r => r.prisParUtilisateur);
        const nonPris = results.filter(r => r.prisParUtilisateur === false);

        const tauxPris = prisParMoi.length > 0
            ? Math.round((prisParMoi.filter(r => r.win).length / prisParMoi.length) * 100)
            : "—";
        const tauxNonPris = nonPris.length > 0
            ? Math.round((nonPris.filter(r => r.win).length / nonPris.length) * 100)
            : "—";
        const tauxTotal = results.length > 0
            ? Math.round((results.filter(r => r.win).length / results.length) * 100)
            : "—";

        const msg =
            `📊 *STATS & RÉGLAGES*\n\n` +
            `*— PARAMÈTRES —*\n` +
            `👉 Possession: ${minPossession}% | Tirs: ${minShots} | Cadrés: ${minOnTarget} | xG: ${minXG}\n\n` +
            `*— TES PERFORMANCES —*\n` +
            `✅ Paris pris: ${prisParMoi.length} → *${tauxPris}%* de réussite\n` +
            `❌ Paris refusés: ${nonPris.length} → *${tauxNonPris}%* auraient gagné\n` +
            `📊 Taux global bot: *${tauxTotal}%*\n\n` +
            `🛡️ Mode prudent: ${modePrudent ? "ACTIF ⚠️" : "Inactif ✅"}\n` +
            `💰 Mise actuelle: ${getMiseOptimale()}% (≈ ${(bankroll * getMiseOptimale() / 100).toFixed(2)}€)`;

        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    else if (data === "menu_recap") {
        bot.sendMessage(chatId, "📅 Lancement du récap du jour...");
        sendDailyRecap();
    }

    else if (data === "menu_bilan") {
        sendNightReport();
    }

    else if (data === "menu_edit_ht") {
        bot.sendMessage(chatId,
            `⚙️ *CRITÈRES MI-TEMPS*\n\nValeurs actuelles:\n👉 Possession: ${minPossession}% | Tirs: ${minShots} | Cadrés: ${minOnTarget} | xG: ${minXG}\n\nCommandes:\n• /setposs [val]\n• /settirs [val]\n• /setcadres [val]\n• /setxg [val]`,
            { parse_mode: "Markdown" }
        );
    }

    else if (data === "menu_edit_live") {
        bot.sendMessage(chatId,
            `⚙️ *CRITÈRES LIVE 60-70MIN*\n\nValeurs: xG: ${minXG_live} | Poss: ${minPoss_live}% | Tirs: ${minShots_live}\n\nCommandes:\n• /setxglive [val]\n• /setposslive [val]\n• /settirslive [val]`,
            { parse_mode: "Markdown" }
        );
    }

    else if (data === "menu_history") {
        const prisParMoi = results.filter(r => r.prisParUtilisateur).slice(-10);
        if (prisParMoi.length === 0) {
            bot.sendMessage(chatId, "📈 Pas encore de paris pris.");
            return;
        }
        let msg = "📈 *TES 10 DERNIERS PARIS*\n\n";
        prisParMoi.forEach((r, i) => {
            msg += `${i + 1}. ${r.win ? "✅ WIN" : "❌ LOSE"} — ${r.home} vs ${r.away}\n`;
            msg += `   xG:${r.homeXG} | Poss:${r.homePoss}% | Tirs:${r.homeShots}\n\n`;
        });
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    else if (data === "menu_manques") {
        // Paris refusés qui auraient gagné
        const manques = results.filter(r => !r.prisParUtilisateur && r.win).slice(-5);
        if (manques.length === 0) {
            bot.sendMessage(chatId, "✅ Aucun bon pari manqué récemment !");
            return;
        }
        let msg = "😬 *PARIS REFUSÉS QUI AURAIENT GAGNÉ*\n\n";
        manques.forEach((r, i) => {
            msg += `${i + 1}. ✅ ${r.home} vs ${r.away}\n`;
            msg += `   xG:${r.homeXG} | Poss:${r.homePoss}%\n\n`;
        });
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    else if (data === "menu_learning") {
        const checkedLive = resultsLive.filter(r => r.checked);
        const winRate = checkedLive.length > 0
            ? Math.round((checkedLive.filter(r => r.win).length / checkedLive.length) * 100)
            : "—";
        bot.sendMessage(chatId,
            `🧠 *AUTO-LEARNING*\n\nMi-temps: ${results.length} matchs analysés\nLive: ${checkedLive.length} signaux | Taux: ${winRate}%`,
            { parse_mode: "Markdown" }
        );
    }

    else if (data === "menu_leagues") {
        const ligues = Object.entries(leagueStats).filter(([, s]) => s.total > 0);
        if (ligues.length === 0) {
            bot.sendMessage(chatId, "🏆 Pas encore de données par ligue.");
            return;
        }
        const sorted = ligues.sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total));
        let msg = "🏆 *STATS PAR LIGUE*\n\n";
        sorted.forEach(([league, stats]) => {
            const taux = Math.round((stats.wins / stats.total) * 100);
            const icone = taux >= 70 ? "⭐" : taux >= 50 ? "✅" : "❌";
            msg += `${icone} ${league}: ${taux}% (${stats.wins}W/${stats.total - stats.wins}L)\n`;
        });
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    else if (data === "menu_bankroll") {
        bot.sendMessage(chatId,
            `💰 *BANKROLL*\n\nBankroll: *${bankroll}€*\nMise actuelle: *${getMiseOptimale()}%* (≈ ${(bankroll * getMiseOptimale() / 100).toFixed(2)}€)\n\n/setbankroll [montant]`,
            { parse_mode: "Markdown" }
        );
    }

    else if (data === "menu_live_now") {
        bot.sendMessage(chatId, "📡 Récupération des matchs en cours...");
        afficherMatchsEnCours();
    }

    else if (data === "menu_reset") {
        const keyboard = { inline_keyboard: [[
            { text: "✅ Confirmer", callback_data: "confirm_reset" },
            { text: "❌ Annuler", callback_data: "menu_back" }
        ]]};
        bot.sendMessage(chatId, "⚠️ Remettre tous les critères par défaut ?", { reply_markup: keyboard });
    }

    else if (data === "confirm_reset") {
        minShots = 5; minOnTarget = 2; minPossession = 51; minXG = 0.5;
        minXG_live = 0.6; minPoss_live = 52; minShots_live = 4;
        modePrudent = false;
        saveData();
        bot.sendMessage(chatId, "✅ Critères réinitialisés !");
    }

    else if (data === "menu_back") {
        sendMainMenu();
    }
});

// ============================================================
// 🎮 MENU PRINCIPAL
// ============================================================

// ============================================================
// 📡 MATCHS EN COURS — stats en temps réel
// ============================================================

async function afficherMatchsEnCours() {
    const matches = await getMatches();
    const grandeLigueMatches = matches.filter(m => estGrandeLigue(m.league.name));

    if (grandeLigueMatches.length === 0) {
        bot.sendMessage(chatId, "📡 Aucun match en cours dans les grandes ligues.");
        return;
    }

    // Trier par minute (les plus avancés en premier)
    grandeLigueMatches.sort((a, b) => (b.fixture.status.elapsed || 0) - (a.fixture.status.elapsed || 0));

    let msg = `📡 *MATCHS EN COURS — ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })}*\n`;
    msg += `🏆 Grandes ligues européennes\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const match of grandeLigueMatches) {
        const home = match.teams.home.name;
        const away = match.teams.away.name;
        const homeGoals = match.goals.home;
        const awayGoals = match.goals.away;
        const minute = match.fixture.status.elapsed || 0;
        const statut = match.fixture.status.short;
        const league = match.league.name;

        const stats = match.statistics;
        let statsLine = "";

        if (stats) {
            const homeStats = stats.find(t => t.team.name === home);
            if (homeStats) {
                const getStat = (team, type) => team.statistics.find(s => s.type === type)?.value || 0;
                const homeShots = getStat(homeStats, "Total Shots");
                const homeOnTarget = getStat(homeStats, "Shots on Goal");
                const homePoss = parseInt(getStat(homeStats, "Ball Possession"));
                const homeXG = parseFloat(getStat(homeStats, "Expected Goals")) || 0;

                // Indicateur visuel si critères remplis
                const hotSignal =
                    homePoss >= minPossession &&
                    homeShots >= minShots &&
                    homeOnTarget >= minOnTarget &&
                    homeXG >= minXG;

                statsLine = `📊 ${home}: Poss ${homePoss}% | Tirs ${homeShots} | Cadrés ${homeOnTarget} | xG ${homeXG}`;
                if (hotSignal) statsLine += ` 🔥`;
            }
        }

        const statutLabel = statut === "HT" ? "⏸️ MI-TEMPS" : `▶️ ${minute}'`;

        msg += `${statutLabel} — 🏆 ${league}\n`;
        msg += `⚽ *${home} ${homeGoals} - ${awayGoals} ${away}*\n`;
        if (statsLine) msg += `${statsLine}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    msg += `🔢 ${grandeLigueMatches.length} match(s) en cours\n`;
    msg += `💡 🔥 = critères remplis pour un signal`;

    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

function isAuthorized(msg) {
    return String(msg.chat.id) === String(chatId);
}

function sendMainMenu() {
    const keyboard = {
        inline_keyboard: [
            [
                { text: "📊 Stats & Réglages", callback_data: "menu_stats" },
                { text: "📅 Récap du jour", callback_data: "menu_recap" }
            ],
            [
                { text: "⚙️ Critères MI-TEMPS", callback_data: "menu_edit_ht" },
                { text: "⚙️ Critères LIVE", callback_data: "menu_edit_live" }
            ],
            [
                { text: "📈 Mes paris", callback_data: "menu_history" },
                { text: "😬 Paris manqués", callback_data: "menu_manques" }
            ],
            [
                { text: "🏆 Stats par ligue", callback_data: "menu_leagues" },
                { text: "💰 Bankroll", callback_data: "menu_bankroll" }
            ],
            [
                { text: "📡 Matchs en cours", callback_data: "menu_live_now" }
            ],
            [
                { text: "🌙 Bilan du jour", callback_data: "menu_bilan" },
                { text: "🔄 Réinitialiser", callback_data: "menu_reset" }
            ]
        ]
    };
    bot.sendMessage(chatId, "🤖 *MENU BOT PARIS*\n\nQue veux-tu faire ?", {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
}

bot.onText(/\/menu/, (msg) => { if (!isAuthorized(msg)) return; sendMainMenu(); });
bot.onText(/\/start/, (msg) => { if (!isAuthorized(msg)) return; bot.sendMessage(chatId, "👋 Bot démarré ! Tape /menu pour le panneau de contrôle."); });

// ============================================================
// 📝 COMMANDES
// ============================================================

bot.onText(/\/setposs (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 45 || val > 75) { bot.sendMessage(chatId, "❌ Valeur entre 45 et 75"); return; }
    minPossession = val; saveData();
    bot.sendMessage(chatId, `✅ Possession → *${minPossession}%*`, { parse_mode: "Markdown" });
});

bot.onText(/\/settirs (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 1 || val > 20) { bot.sendMessage(chatId, "❌ Valeur entre 1 et 20"); return; }
    minShots = val; saveData();
    bot.sendMessage(chatId, `✅ Tirs → *${minShots}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setcadres (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 1 || val > 10) { bot.sendMessage(chatId, "❌ Valeur entre 1 et 10"); return; }
    minOnTarget = val; saveData();
    bot.sendMessage(chatId, `✅ Cadrés → *${minOnTarget}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setxg (.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val < 0.1 || val > 3) { bot.sendMessage(chatId, "❌ Valeur entre 0.1 et 3"); return; }
    minXG = val; saveData();
    bot.sendMessage(chatId, `✅ xG → *${minXG}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setxglive (.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val < 0.1 || val > 3) { bot.sendMessage(chatId, "❌ Valeur entre 0.1 et 3"); return; }
    minXG_live = val; saveData();
    bot.sendMessage(chatId, `✅ xG live → *${minXG_live}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setposslive (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 45 || val > 75) { bot.sendMessage(chatId, "❌ Valeur entre 45 et 75"); return; }
    minPoss_live = val; saveData();
    bot.sendMessage(chatId, `✅ Possession live → *${minPoss_live}%*`, { parse_mode: "Markdown" });
});

bot.onText(/\/settirslive (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 1 || val > 20) { bot.sendMessage(chatId, "❌ Valeur entre 1 et 20"); return; }
    minShots_live = val; saveData();
    bot.sendMessage(chatId, `✅ Tirs live → *${minShots_live}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setbankroll (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 10 || val > 100000) { bot.sendMessage(chatId, "❌ Valeur entre 10 et 100000"); return; }
    bankroll = val; saveData();
    bot.sendMessage(chatId, `✅ Bankroll → *${bankroll}€* | Mise: ${getMiseOptimale()}% (≈ ${(bankroll * getMiseOptimale() / 100).toFixed(2)}€)`, { parse_mode: "Markdown" });
});

bot.onText(/\/modeprudent (.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = match[1].toLowerCase();
    if (val === "on") { modePrudent = true; saveData(); bot.sendMessage(chatId, "🛡️ Mode prudent activé."); }
    else if (val === "off") { modePrudent = false; saveData(); bot.sendMessage(chatId, "✅ Mode prudent désactivé."); }
});

// ============================================================
// 🤖 ANALYSE MI-TEMPS — toutes les minutes
// ============================================================

setInterval(async () => {
    const matches = await getMatches();
    const grandeLigueMatches = matches.filter(m => estGrandeLigue(m.league.name));
    const halfMatches = grandeLigueMatches.filter(m => m.fixture.status.short === "HT");

    for (const match of halfMatches) {
        const matchId = match.fixture.id;
        if (!sentMatches.includes(matchId)) {

            // Signal classique (possession/tirs/xG)
            const result = analyseMatch(match);
            if (result) {
                envoyerSignalAvecBoutons(result);
                fs.appendFileSync("history.txt", result.message + "\n\n");
            }

            // Signal xG avancé (différentiel + frustration + combo)
            const resultXG = analyseXGAvance(match);
            if (resultXG) {
                // Éviter doublon si signal classique déjà envoyé sur même match
                const dejaEnvoye = result !== null;
                if (!dejaEnvoye || resultXG.scoreConseil > (result?.scoreConseil || 0) + 20) {
                    envoyerSignalAvecBoutons(resultXG);
                    fs.appendFileSync("history.txt", resultXG.message + "\n\n");
                }
            }

            sentMatches.push(matchId);
            saveData();
        }
    }
}, 60000);

// ============================================================
// ⏱️ ANALYSE 60-70 MIN — toutes les minutes
// ============================================================

function analyseMatchLive(match) {
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const homeGoals = match.goals.home;
    const awayGoals = match.goals.away;
    const minute = match.fixture.status.elapsed;

    if (!minute || minute < 60 || minute > 70) return null;

    const stats = match.statistics;
    if (!stats) return null;

    const homeStats = stats.find(t => t.team.name === home);
    if (!homeStats) return null;

    const getStat = (team, type) =>
        team.statistics.find(s => s.type === type)?.value || 0;

    const homeShots = getStat(homeStats, "Total Shots");
    const homeOnTarget = getStat(homeStats, "Shots on Goal");
    const homePoss = parseInt(getStat(homeStats, "Ball Possession"));
    const homeXG = parseFloat(getStat(homeStats, "Expected Goals")) || 0;

    if (homeXG < minXG_live || homePoss < minPoss_live || homeShots < minShots_live) return null;

    let confidence = 0;
    if (homeXG >= minXG_live) confidence += 40;
    if (homePoss >= minPoss_live) confidence += 30;
    if (homeShots >= minShots_live) confidence += 30;
    if (homeOnTarget >= 2) confidence += 10;

    const mise = getMiseOptimale();
    const { recommandation } = getConseil("live_v1", match.league.name, homePoss, homeXG, homeShots);

    return {
        message: `⏱️ SIGNAL LIVE 60-70' ⏱️\n\n⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n🕐 Minute: ${minute}'\n\n📊 Domination V1:\n👉 Possession: ${homePoss}%\n👉 Tirs: ${homeShots} | Cadrés: ${homeOnTarget}\n👉 xG: ${homeXG}\n\n${recommandation}\n💡 Confiance: ${Math.min(confidence, 95)}%\n💰 Mise suggérée: ${mise}% (≈ ${(bankroll * mise / 100).toFixed(2)}€)\n\n👇 *Tu prends ce pari ?*`,
        confidence,
        type: "live_v1",
        fixtureId: match.fixture.id,
        league: match.league.name,
        data: { homeShots, homeOnTarget, homePoss, homeXG, home, away, homeGoals, awayGoals }
    };
}

setInterval(async () => {
    const matches = await getMatches();
    const grandeLigueMatches = matches.filter(m => estGrandeLigue(m.league.name));
    const liveMatches = grandeLigueMatches.filter(m => {
        const min = m.fixture.status.elapsed;
        return min >= 60 && min <= 70;
    });

    for (const match of liveMatches) {
        const matchId = `live_${match.fixture.id}`;
        if (!sentMatchesLive.includes(matchId)) {
            const result = analyseMatchLive(match);
            if (result && result.confidence >= 60) {
                const league = match.league.name;
                const msgAvecLigue = `🏆 ${league}\n\n` + result.message;

                const keyboard = {
                    inline_keyboard: [[
                        { text: "✅ OUI je prends", callback_data: `pari_oui_${result.fixtureId}` },
                        { text: "❌ NON je passe", callback_data: `pari_non_${result.fixtureId}` }
                    ]]
                };

                bot.sendMessage(chatId, msgAvecLigue, { parse_mode: "Markdown", reply_markup: keyboard });
                fs.appendFileSync("history_live.txt", msgAvecLigue + "\n\n");

                pendingValidation[result.fixtureId] = {
                    signalType: result.type,
                    league,
                    timestamp: Date.now(),
                    data: result.data,
                    decision: null
                };

                sentMatchesLive.push(matchId);
                saveData();
            }
        }
    }
}, 60000);

// ============================================================
// 🧠 CHECK RÉSULTATS — toutes les 5 minutes
// ============================================================

setInterval(async () => {
    for (let bet of pendingBets) {
        if (bet.checked) continue;
        try {
            const res = await axios.get(
                `https://v3.football.api-sports.io/fixtures?id=${bet.fixtureId}`,
                { headers: { 'x-apisports-key': apiKey } }
            );
            const match = res.data.response[0];

            if (match.fixture.status.short === "FT") {
                const totalGoals = match.goals.home + match.goals.away;
                let win = false;
                if (bet.type === "over" && totalGoals >= 2) win = true;
                if (bet.type === "next_goal" && totalGoals >= 2) win = true;
                if (bet.type === "perfect" && totalGoals >= 2) win = true;
                if (bet.type === "live_v1") win = match.goals.home > bet.goalsHomeAtSignal;

                bet.checked = true;

                // Message de résultat personnalisé selon décision
                if (bet.prisParUtilisateur) {
                    bot.sendMessage(chatId,
                        `${win ? "✅ WIN !" : "❌ LOSE"}\n\n` +
                        `⚽ ${bet.home} vs ${bet.away}\n` +
                        `📊 xG: ${bet.homeXG} | Poss: ${bet.homePoss}%\n` +
                        `${win ? "🎉 Bien joué !" : "😕 Pas de chance, on continue !"}`,
                        { parse_mode: "Markdown" }
                    );
                } else {
                    // Pari refusé — on informe du résultat pour apprentissage
                    bot.sendMessage(chatId,
                        `📊 *Résultat du pari que tu as refusé:*\n\n` +
                        `⚽ ${bet.home} vs ${bet.away}\n` +
                        `${win ? "✅ Aurait été un WIN" : "❌ Aurait été un LOSE"}\n\n` +
                        `${win ? "🤔 A retenir pour la prochaine fois !" : "✅ Bonne décision de passer !"}`,
                        { parse_mode: "Markdown" }
                    );
                }

                results.push({ ...bet, win, timestamp: Date.now() });
                if (bet.league) updateLeagueStats(bet.league, win);
                verifierSeriePerdante();
                saveData();
            }
        } catch (err) {
            console.log("Erreur check:", err.message);
        }
    }
}, 300000);

// ============================================================
// 🧠 AUTO LEARNING — toutes les 10 minutes
// ============================================================

setInterval(() => {
    // Apprentissage uniquement sur les paris PRIS par l'utilisateur
    const prisParMoi = results.filter(r => r.prisParUtilisateur);
    if (prisParMoi.length < 10) return;

    const wins = prisParMoi.filter(r => r.win);
    const losses = prisParMoi.filter(r => !r.win);
    if (wins.length === 0 || losses.length === 0) return;

    const avg = (arr, key) => arr.reduce((a, b) => a + b[key], 0) / arr.length;

    if (avg(wins, "homeShots") > avg(losses, "homeShots")) minShots = Math.round(avg(wins, "homeShots"));
    if (avg(wins, "homePoss") > avg(losses, "homePoss")) minPossession = Math.round(avg(wins, "homePoss"));
    if (avg(wins, "homeXG") > avg(losses, "homeXG")) minXG = parseFloat(avg(wins, "homeXG").toFixed(1));

    saveData();
    console.log("🧠 AUTO LEARNING — Shots:", minShots, "| Poss:", minPossession, "| xG:", minXG);
}, 600000);

// ============================================================
// 🌙 BILAN NOCTURNE 23H
// ============================================================

async function sendNightReport() {
    const today = new Date().toLocaleDateString('fr-FR');
    const hier = Date.now() - 24 * 60 * 60 * 1000;

    const aujourdhui = results.filter(r => r.timestamp && r.timestamp > hier);
    const prisAujourdhui = aujourdhui.filter(r => r.prisParUtilisateur);
    const refusesAujourdhui = aujourdhui.filter(r => !r.prisParUtilisateur);

    const tauxGlobal = results.length > 0
        ? Math.round((results.filter(r => r.win && r.prisParUtilisateur).length / results.filter(r => r.prisParUtilisateur).length) * 100)
        : 0;

    const topLigues = Object.entries(leagueStats)
        .filter(([, s]) => s.total >= 3)
        .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))
        .slice(0, 3);

    let msg = `🌙 *BILAN DU JOUR — ${today}*\n\n`;
    msg += `📊 *Aujourd'hui:*\n`;
    msg += `👉 Signaux reçus: ${aujourdhui.length}\n`;
    msg += `✅ Paris pris: ${prisAujourdhui.length} → ${prisAujourdhui.filter(r => r.win).length}W / ${prisAujourdhui.filter(r => !r.win).length}L\n`;
    msg += `❌ Paris refusés: ${refusesAujourdhui.length} → ${refusesAujourdhui.filter(r => r.win).length} auraient gagné\n\n`;
    msg += `📈 *Global:* ${tauxGlobal}% de réussite sur tes paris\n\n`;

    if (topLigues.length > 0) {
        msg += `🏆 *Top ligues:*\n`;
        topLigues.forEach(([league, stats]) => {
            msg += `👉 ${league}: ${Math.round((stats.wins / stats.total) * 100)}%\n`;
        });
        msg += `\n`;
    }

    msg += `🛡️ Mode prudent: ${modePrudent ? "ACTIF ⚠️" : "Inactif ✅"}\n`;
    msg += `💰 Mise: ${getMiseOptimale()}% bankroll`;

    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

// ============================================================
// 📅 RÉCAP QUOTIDIEN 10H
// ============================================================

async function getMatchesOfDay() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const response = await axios.get(
            `https://v3.football.api-sports.io/fixtures?date=${today}`,
            { headers: { 'x-apisports-key': apiKey } }
        );
        return response.data.response;
    } catch (err) {
        console.log("Erreur getMatchesOfDay :", err.message);
        return [];
    }
}

async function getOdds(fixtureId) {
    try {
        const response = await axios.get(
            `https://v3.football.api-sports.io/odds?fixture=${fixtureId}&bookmaker=1`,
            { headers: { 'x-apisports-key': apiKey } }
        );
        const data = response.data.response;
        if (!data || data.length === 0) return null;
        const bookmaker = data[0]?.bookmakers?.[0];
        if (!bookmaker) return null;
        const market = bookmaker.bets.find(b => b.name === "Match Winner");
        if (!market) return null;
        const v1 = parseFloat(market.values.find(v => v.value === "Home")?.odd);
        const vN = parseFloat(market.values.find(v => v.value === "Draw")?.odd);
        const ve = parseFloat(market.values.find(v => v.value === "Away")?.odd);
        return { v1, vN, ve };
    } catch (err) {
        return null;
    }
}

async function sendDailyRecap() {
    const matches = await getMatchesOfDay();
    if (matches.length === 0) { bot.sendMessage(chatId, "📅 Aucun match trouvé."); return; }

    const V1_MIN = 1.90, V1_MAX = 2.50, VE_MIN = 2.10, VE_MAX = 4.00;
    let filteredMatches = [];

    for (const match of matches) {
        if (!estGrandeLigue(match.league.name)) continue;
        const fixtureId = match.fixture.id;
        const home = match.teams.home.name;
        const away = match.teams.away.name;
        const league = match.league.name;
        const country = match.league.country;
        const timeStr = new Date(match.fixture.date).toLocaleTimeString('fr-FR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris'
        });
        const odds = await getOdds(fixtureId);
        if (!odds) continue;
        const { v1, vN, ve } = odds;
        const leagueBonus = getLeagueScore(league) >= 0.7 ? " ⭐" : "";
        if (v1 >= V1_MIN && v1 <= V1_MAX && ve >= VE_MIN && ve <= VE_MAX) {
            filteredMatches.push({ home, away, league, country, timeStr, v1, vN, ve, leagueBonus });
        }
        await new Promise(r => setTimeout(r, 200));
    }

    if (filteredMatches.length === 0) { bot.sendMessage(chatId, "📅 Aucun match ne correspond aux critères."); return; }

    let msg = `📅 *MATCHS DU JOUR — ${new Date().toLocaleDateString('fr-FR')}*\n🏆 Grandes ligues | 🎯 V1: 1.90-2.50 | V2: 2.10-4.00\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const m of filteredMatches) {
        msg += `⚽ ${m.home} vs ${m.away}${m.leagueBonus}\n🏆 ${m.league} (${m.country})\n🕐 ${m.timeStr}\n📊 V1: ${m.v1} | N: ${m.vN} | V2: ${m.ve}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }
    msg += `🔢 Total: ${filteredMatches.length} match(s)`;
    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

// ⏰ Schedulers 10h + 23h
setInterval(() => {
    const parisTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const h = parisTime.getHours();
    const m = parisTime.getMinutes();
    if (h === 10 && m === 0) sendDailyRecap();
    if (h === 23 && m === 0) sendNightReport();
}, 60000);
