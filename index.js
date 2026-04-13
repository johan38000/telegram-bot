require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.API_KEY;
const chatId = "1633310404";

const bot = new TelegramBot(token, { polling: true });

console.log("🔥 BOT FINAL LANCÉ");

// ============================================================
// 💾 SAUVEGARDE / CHARGEMENT — persistance au redémarrage
// ============================================================

const DATA_FILE = 'botdata.json';

function saveData() {
    const data = {
        minShots, minOnTarget, minPossession, minXG,
        minXG_live, minPoss_live, minShots_live,
        results, resultsLive,
        sentMatches, sentMatchesLive,
        leagueStats,
        modePrudent,
        bankroll
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

// 🎯 Paramètres adaptatifs — mi-temps
let minShots = 5;
let minOnTarget = 2;
let minPossession = 51;
let minXG = 0.5;

// 🎯 Paramètres adaptatifs — signal 60-70min
let minXG_live = 0.6;
let minPoss_live = 52;
let minShots_live = 4;

// 📊 Stats par ligue — mémorisation des ligues rentables
let leagueStats = {};

// 🛡️ Mode prudent — activé automatiquement si série de pertes
let modePrudent = false;

// 💰 Bankroll de référence (modifiable via /setbankroll)
let bankroll = 100;

// Chargement des données sauvegardées
loadData();

// 🏆 FILTRE GRANDES LIGUES EUROPÉENNES
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
// 💰 GESTION BANKROLL AUTOMATIQUE (Niveau 2)
// ============================================================

function getMiseOptimale() {
    // Calcule le taux de réussite récent (10 derniers résultats)
    const derniers = results.slice(-10);
    if (derniers.length < 3) return 1; // pas assez de données → mise minimale

    const wins = derniers.filter(r => r.win).length;
    const tauxRecent = wins / derniers.length;

    // Kelly simplifié : on ne risque jamais plus de 5%
    if (modePrudent) return 0.5;       // mode prudent → mise réduite
    if (tauxRecent >= 0.8) return 3;   // très bonne forme → 3%
    if (tauxRecent >= 0.65) return 2;  // bonne forme → 2%
    if (tauxRecent >= 0.5) return 1;   // forme moyenne → 1%
    return 0.5;                        // mauvaise forme → 0.5%
}

// ============================================================
// 🛡️ DÉTECTION SÉRIE DE PERTES — Mode prudent (Niveau 1)
// ============================================================

function verifierSeriePerdante() {
    const derniers = results.slice(-3);
    if (derniers.length < 3) return;

    const tousPerdu = derniers.every(r => !r.win);

    if (tousPerdu && !modePrudent) {
        modePrudent = true;
        saveData();
        bot.sendMessage(chatId,
            `⚠️ *ALERTE MODE PRUDENT ACTIVÉ*\n\n` +
            `3 paris perdants consécutifs détectés.\n\n` +
            `🛡️ Le bot passe automatiquement en mode prudent:\n` +
            `👉 Critères rehaussés temporairement\n` +
            `👉 Mises réduites à 0.5% bankroll\n\n` +
            `Le mode prudent se désactivera automatiquement après 2 wins consécutifs.\n` +
            `Ou tape /modeprudent off pour le désactiver manuellement.`,
            { parse_mode: "Markdown" }
        );

        // Rehausser les critères temporairement
        minPossession = Math.min(minPossession + 5, 70);
        minXG = parseFloat((minXG + 0.2).toFixed(1));
        minShots = Math.min(minShots + 2, 15);
        saveData();
    }

    // Désactivation auto après 2 wins consécutifs
    const deuxDerniers = results.slice(-2);
    if (deuxDerniers.length === 2 && deuxDerniers.every(r => r.win) && modePrudent) {
        modePrudent = false;
        saveData();
        bot.sendMessage(chatId,
            `✅ *MODE PRUDENT DÉSACTIVÉ*\n\n` +
            `2 wins consécutifs — le bot reprend en mode normal ! 🔥`,
            { parse_mode: "Markdown" }
        );
    }
}

// ============================================================
// 📊 STATS PAR LIGUE (Niveau 2)
// ============================================================

function updateLeagueStats(league, win) {
    if (!leagueStats[league]) {
        leagueStats[league] = { wins: 0, total: 0 };
    }
    leagueStats[league].total++;
    if (win) leagueStats[league].wins++;
    saveData();
}

function getLeagueScore(league) {
    const stats = leagueStats[league];
    if (!stats || stats.total < 3) return 1; // pas assez de données → neutre
    return stats.wins / stats.total;
}

// ============================================================
// 📊 PROBA + MISE
// ============================================================

function getPredictionLevel(score, homeXG) {
    let probability = 50 + score * 0.3 + homeXG * 10;
    if (probability > 90) probability = 90;

    const mise = getMiseOptimale();
    return { probability: Math.round(probability), stake: mise };
}

// 🔥 API matchs live
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

// 🧠 ANALYSE MI-TEMPS
function analyseMatch(match) {
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const homeGoals = match.goals.home;
    const awayGoals = match.goals.away;
    const league = match.league.name;

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

    // En mode prudent on est plus strict
    const seuilPoss = modePrudent ? minPossession + 5 : minPossession;
    const seuilXG = modePrudent ? minXG + 0.2 : minXG;
    const seuilShots = modePrudent ? minShots + 2 : minShots;

    let score = 0;
    if (homePoss > seuilPoss) score += 25;
    if (homeShots >= seuilShots) score += 25;
    if (homeOnTarget >= minOnTarget) score += 25;
    if (homeXG >= seuilXG) score += 25;

    const { probability, stake } = getPredictionLevel(score, homeXG);

    // Bonus si ligue rentable historiquement
    const leagueBonus = getLeagueScore(league) >= 0.7 ? "⭐ Ligue rentable" : "";

    const modePrudentTag = modePrudent ? "\n🛡️ MODE PRUDENT ACTIF" : "";

    // 🟢 MATCH PARFAIT
    if (homePoss >= 62 && homeShots >= 10 && homeOnTarget >= 5 && homeXG >= 1.5 && homeGoals <= awayGoals) {
        return {
            message: `🟢🟢 MATCH PARFAIT 🟢🟢${modePrudentTag}\n\n⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n${leagueBonus}\n\n📊 ULTRA DOMINATION:\n👉 Possession: ${homePoss}%\n👉 Tirs: ${homeShots}\n👉 Cadrés: ${homeOnTarget}\n👉 xG: ${homeXG}\n\n🔥 PROBA: ${probability}%\n\n💰 MISE: ${stake}% bankroll (≈ ${(bankroll * stake / 100).toFixed(2)}€)\n\n🎯 PARI:\n👉 ${home} prochain but\n👉 Over 1.5`,
            confidence: 100, type: "perfect", league,
            data: { homeShots, homeOnTarget, homePoss, homeXG }
        };
    }

    // 🚨 SIGNAL PREMIUM
    if (homePoss > 60 && homeShots >= 8 && homeOnTarget >= 4 && homeXG >= 1.2 && homeGoals <= awayGoals) {
        return {
            message: `🚨 SIGNAL PREMIUM 🚨${modePrudentTag}\n\n⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n${leagueBonus}\n\n📊 PRESSION:\n👉 ${homeShots} tirs | ${homeOnTarget} cadrés | ${homePoss}% | xG ${homeXG}\n\n🔥 PROBA: ${probability}%\n\n💰 MISE: ${stake}% bankroll (≈ ${(bankroll * stake / 100).toFixed(2)}€)\n\n🎯 PARI:\n👉 ${home} prochain but`,
            confidence: score + 10, type: "next_goal", league,
            data: { homeShots, homeOnTarget, homePoss, homeXG }
        };
    }

    // 🔥 VALUE BET
    if (homeGoals <= awayGoals && score >= 75) {
        return {
            message: `🔥 VALUE BET 🔥${modePrudentTag}\n\n⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n${leagueBonus}\n\n📊 Stats:\n👉 ${homePoss}% | ${homeShots} tirs | ${homeOnTarget} cadrés | xG ${homeXG}\n\n🔥 PROBA: ${probability}%\n\n💰 MISE: ${stake}% bankroll (≈ ${(bankroll * stake / 100).toFixed(2)}€)\n\n🎯 PARI:\n👉 But ${home}\n👉 Over 1.5`,
            confidence: score, type: "over", league,
            data: { homeShots, homeOnTarget, homePoss, homeXG }
        };
    }

    return null;
}

// ⏱️ ANALYSE 60-70 MIN
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

    return {
        message: `⏱️ SIGNAL LIVE 60-70' ⏱️\n\n⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n🕐 Minute: ${minute}'\n\n📊 Domination V1:\n👉 Possession: ${homePoss}%\n👉 Tirs totaux: ${homeShots}\n👉 Cadrés: ${homeOnTarget}\n👉 xG: ${homeXG} 🔬\n\n🎯 BUT PROBABLE: ${home}\n💡 Confiance: ${Math.min(confidence, 95)}%\n💰 MISE: ${mise}% bankroll (≈ ${(bankroll * mise / 100).toFixed(2)}€)\n\n⚠️ Signal expérimental — auto-apprentissage en cours`,
        confidence, type: "live_v1",
        data: { homeShots, homeOnTarget, homePoss, homeXG }
    };
}

// ============================================================
// 📊 BILAN QUOTIDIEN AUTOMATIQUE À 23H (Niveau 1)
// ============================================================

async function sendNightReport() {
    const today = new Date().toLocaleDateString('fr-FR');

    // Résultats du jour — on prend les résultats des dernières 24h
    const maintenant = Date.now();
    const hier = maintenant - 24 * 60 * 60 * 1000;

    const resultsAujourdhui = results.filter(r => r.timestamp && r.timestamp > hier);
    const livesToday = resultsLive.filter(r => r.timestamp && r.timestamp > hier && r.checked);

    const totalHT = resultsAujourdhui.length;
    const winsHT = resultsAujourdhui.filter(r => r.win).length;

    const totalLive = livesToday.length;
    const winsLive = livesToday.filter(r => r.win).length;

    const totalJour = totalHT + totalLive;
    const winsJour = winsHT + winsLive;

    // Stats globales
    const totalAll = results.length;
    const winsAll = results.filter(r => r.win).length;
    const tauxGlobal = totalAll > 0 ? Math.round((winsAll / totalAll) * 100) : 0;

    // Top ligues
    const topLigues = Object.entries(leagueStats)
        .filter(([, s]) => s.total >= 3)
        .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))
        .slice(0, 3);

    let msg = `🌙 *BILAN DU JOUR — ${today}*\n\n`;

    if (totalJour === 0) {
        msg += `Aucun signal envoyé aujourd'hui.\n\n`;
    } else {
        msg += `📊 *Aujourd'hui:*\n`;
        msg += `👉 Signaux envoyés: ${totalJour}\n`;
        msg += `✅ Wins: ${winsJour} | ❌ Losses: ${totalJour - winsJour}\n`;
        msg += `🎯 Taux du jour: ${totalJour > 0 ? Math.round((winsJour / totalJour) * 100) : "—"}%\n\n`;
    }

    msg += `📈 *Global (tous les matchs):*\n`;
    msg += `👉 Total analysés: ${totalAll}\n`;
    msg += `✅ Wins: ${winsAll} | ❌ Losses: ${totalAll - winsAll}\n`;
    msg += `🎯 Taux global: ${tauxGlobal}%\n\n`;

    if (topLigues.length > 0) {
        msg += `🏆 *Top ligues rentables:*\n`;
        topLigues.forEach(([league, stats]) => {
            const taux = Math.round((stats.wins / stats.total) * 100);
            msg += `👉 ${league}: ${taux}% (${stats.wins}W/${stats.total})\n`;
        });
        msg += `\n`;
    }

    msg += `🛡️ Mode prudent: ${modePrudent ? "ACTIF ⚠️" : "Inactif ✅"}\n`;
    msg += `💰 Mise actuelle: ${getMiseOptimale()}% bankroll`;

    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    console.log("🌙 Bilan nocturne envoyé");
}

// ============================================================
// 🎮 MENU TELEGRAM INTERACTIF
// ============================================================

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
                { text: "📈 Historique résultats", callback_data: "menu_history" },
                { text: "🧠 Auto-learning", callback_data: "menu_learning" }
            ],
            [
                { text: "🏆 Stats par ligue", callback_data: "menu_leagues" },
                { text: "💰 Bankroll", callback_data: "menu_bankroll" }
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

bot.onText(/\/menu/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendMainMenu();
});

bot.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg)) return;
    bot.sendMessage(chatId, "👋 Bot démarré ! Tape /menu pour accéder au panneau de contrôle.");
});

// 🎯 Gestion des boutons
bot.on('callback_query', async (query) => {
    if (String(query.message.chat.id) !== String(chatId)) return;
    const data = query.data;
    bot.answerCallbackQuery(query.id);

    // 📊 STATS
    if (data === "menu_stats") {
        const totalHT = results.length;
        const winsHT = results.filter(r => r.win).length;
        const tauxHT = totalHT > 0 ? Math.round((winsHT / totalHT) * 100) : "—";

        const totalLive = resultsLive.filter(r => r.checked).length;
        const winsLive = resultsLive.filter(r => r.win).length;
        const tauxLive = totalLive > 0 ? Math.round((winsLive / totalLive) * 100) : "—";

        const msg =
            `📊 *RÉGLAGES ACTUELS*\n\n` +
            `*— MI-TEMPS —*\n` +
            `👉 Possession min: ${minPossession}%\n` +
            `👉 Tirs min: ${minShots}\n` +
            `👉 Cadrés min: ${minOnTarget}\n` +
            `👉 xG min: ${minXG}\n\n` +
            `*— LIVE 60-70min —*\n` +
            `👉 xG min: ${minXG_live}\n` +
            `👉 Possession min: ${minPoss_live}%\n` +
            `👉 Tirs min: ${minShots_live}\n\n` +
            `*— PERFORMANCES —*\n` +
            `🏟️ Mi-temps: ${winsHT}W / ${totalHT - winsHT}L → *${tauxHT}%*\n` +
            `⏱️ Live 60-70': ${winsLive}W / ${totalLive - winsLive}L → *${tauxLive}%*\n\n` +
            `🛡️ Mode prudent: ${modePrudent ? "ACTIF ⚠️" : "Inactif ✅"}\n` +
            `💰 Mise actuelle: ${getMiseOptimale()}% (≈ ${(bankroll * getMiseOptimale() / 100).toFixed(2)}€)`;

        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    // 📅 RÉCAP
    else if (data === "menu_recap") {
        bot.sendMessage(chatId, "📅 Lancement du récap du jour...");
        sendDailyRecap();
    }

    // 🌙 BILAN
    else if (data === "menu_bilan") {
        sendNightReport();
    }

    // ⚙️ CRITÈRES MI-TEMPS
    else if (data === "menu_edit_ht") {
        bot.sendMessage(chatId,
            `⚙️ *CRITÈRES MI-TEMPS*\n\n` +
            `Valeurs actuelles:\n` +
            `👉 Possession: ${minPossession}%\n` +
            `👉 Tirs: ${minShots}\n` +
            `👉 Cadrés: ${minOnTarget}\n` +
            `👉 xG: ${minXG}\n\n` +
            `Commandes:\n` +
            `• /setposs [valeur] — ex: /setposs 53\n` +
            `• /settirs [valeur] — ex: /settirs 6\n` +
            `• /setcadres [valeur] — ex: /setcadres 3\n` +
            `• /setxg [valeur] — ex: /setxg 0.6`,
            { parse_mode: "Markdown" }
        );
    }

    // ⚙️ CRITÈRES LIVE
    else if (data === "menu_edit_live") {
        bot.sendMessage(chatId,
            `⚙️ *CRITÈRES LIVE 60-70MIN*\n\n` +
            `Valeurs actuelles:\n` +
            `👉 xG: ${minXG_live}\n` +
            `👉 Possession: ${minPoss_live}%\n` +
            `👉 Tirs: ${minShots_live}\n\n` +
            `Commandes:\n` +
            `• /setxglive [valeur]\n` +
            `• /setposslive [valeur]\n` +
            `• /settirslive [valeur]`,
            { parse_mode: "Markdown" }
        );
    }

    // 📈 HISTORIQUE
    else if (data === "menu_history") {
        const derniers = results.slice(-10);
        if (derniers.length === 0) {
            bot.sendMessage(chatId, "📈 Pas encore de résultats enregistrés.");
            return;
        }
        let msg = "📈 *10 DERNIERS RÉSULTATS MI-TEMPS*\n\n";
        derniers.forEach((r, i) => {
            msg += `${i + 1}. ${r.win ? "✅ WIN" : "❌ LOSE"} — xG:${r.homeXG} | Poss:${r.homePoss}% | Tirs:${r.homeShots}\n`;
        });
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    // 🧠 AUTO-LEARNING
    else if (data === "menu_learning") {
        const checkedLive = resultsLive.filter(r => r.checked);
        const winRate = checkedLive.length > 0
            ? Math.round((checkedLive.filter(r => r.win).length / checkedLive.length) * 100)
            : "—";

        bot.sendMessage(chatId,
            `🧠 *STATUT AUTO-LEARNING*\n\n` +
            `*Mi-temps:*\n` +
            `👉 Matchs analysés: ${results.length}\n` +
            `👉 Prochain ajustement: ${Math.max(0, 10 - results.length)} matchs\n\n` +
            `*Live 60-70min:*\n` +
            `👉 Signaux analysés: ${checkedLive.length}\n` +
            `👉 Taux de réussite: ${winRate}%\n` +
            `👉 Prochain ajustement: ${Math.max(0, 5 - checkedLive.length)} signaux`,
            { parse_mode: "Markdown" }
        );
    }

    // 🏆 STATS PAR LIGUE
    else if (data === "menu_leagues") {
        const ligues = Object.entries(leagueStats).filter(([, s]) => s.total > 0);
        if (ligues.length === 0) {
            bot.sendMessage(chatId, "🏆 Pas encore de données par ligue.");
            return;
        }
        const sorted = ligues.sort((a, b) =>
            (b[1].wins / b[1].total) - (a[1].wins / a[1].total)
        );
        let msg = "🏆 *STATS PAR LIGUE*\n\n";
        sorted.forEach(([league, stats]) => {
            const taux = Math.round((stats.wins / stats.total) * 100);
            const etoile = taux >= 70 ? " ⭐" : taux >= 50 ? " ✅" : " ❌";
            msg += `${league}${etoile}\n👉 ${taux}% (${stats.wins}W / ${stats.total - stats.wins}L)\n\n`;
        });
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    // 💰 BANKROLL
    else if (data === "menu_bankroll") {
        bot.sendMessage(chatId,
            `💰 *GESTION BANKROLL*\n\n` +
            `Bankroll actuelle: *${bankroll}€*\n` +
            `Mise actuelle: *${getMiseOptimale()}%* (≈ ${(bankroll * getMiseOptimale() / 100).toFixed(2)}€)\n\n` +
            `*Échelle automatique:*\n` +
            `👉 Taux ≥ 80% → 3% bankroll\n` +
            `👉 Taux ≥ 65% → 2% bankroll\n` +
            `👉 Taux ≥ 50% → 1% bankroll\n` +
            `👉 Taux < 50% → 0.5% bankroll\n` +
            `👉 Mode prudent → 0.5% bankroll\n\n` +
            `Pour changer ta bankroll:\n/setbankroll [montant] — ex: /setbankroll 200`,
            { parse_mode: "Markdown" }
        );
    }

    // 🔄 RESET
    else if (data === "menu_reset") {
        const keyboard = {
            inline_keyboard: [[
                { text: "✅ Confirmer reset", callback_data: "confirm_reset" },
                { text: "❌ Annuler", callback_data: "menu_back" }
            ]]
        };
        bot.sendMessage(chatId, "⚠️ Remettre tous les critères aux valeurs par défaut ?", {
            reply_markup: keyboard
        });
    }

    else if (data === "confirm_reset") {
        minShots = 5; minOnTarget = 2; minPossession = 51; minXG = 0.5;
        minXG_live = 0.6; minPoss_live = 52; minShots_live = 4;
        modePrudent = false;
        saveData();
        bot.sendMessage(chatId, "✅ Critères réinitialisés aux valeurs par défaut !");
    }

    else if (data === "menu_back") {
        sendMainMenu();
    }
});

// ============================================================
// 📝 COMMANDES DE MODIFICATION
// ============================================================

bot.onText(/\/setposs (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 45 || val > 75) { bot.sendMessage(chatId, "❌ Valeur entre 45 et 75"); return; }
    minPossession = val; saveData();
    bot.sendMessage(chatId, `✅ Possession minimum → *${minPossession}%*`, { parse_mode: "Markdown" });
});

bot.onText(/\/settirs (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 1 || val > 20) { bot.sendMessage(chatId, "❌ Valeur entre 1 et 20"); return; }
    minShots = val; saveData();
    bot.sendMessage(chatId, `✅ Tirs minimum → *${minShots}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setcadres (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 1 || val > 10) { bot.sendMessage(chatId, "❌ Valeur entre 1 et 10"); return; }
    minOnTarget = val; saveData();
    bot.sendMessage(chatId, `✅ Tirs cadrés minimum → *${minOnTarget}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setxg (.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val < 0.1 || val > 3) { bot.sendMessage(chatId, "❌ Valeur entre 0.1 et 3"); return; }
    minXG = val; saveData();
    bot.sendMessage(chatId, `✅ xG minimum mi-temps → *${minXG}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setxglive (.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val < 0.1 || val > 3) { bot.sendMessage(chatId, "❌ Valeur entre 0.1 et 3"); return; }
    minXG_live = val; saveData();
    bot.sendMessage(chatId, `✅ xG minimum live → *${minXG_live}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setposslive (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 45 || val > 75) { bot.sendMessage(chatId, "❌ Valeur entre 45 et 75"); return; }
    minPoss_live = val; saveData();
    bot.sendMessage(chatId, `✅ Possession minimum live → *${minPoss_live}%*`, { parse_mode: "Markdown" });
});

bot.onText(/\/settirslive (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 1 || val > 20) { bot.sendMessage(chatId, "❌ Valeur entre 1 et 20"); return; }
    minShots_live = val; saveData();
    bot.sendMessage(chatId, `✅ Tirs minimum live → *${minShots_live}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setbankroll (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 10 || val > 100000) { bot.sendMessage(chatId, "❌ Valeur entre 10 et 100000"); return; }
    bankroll = val; saveData();
    bot.sendMessage(chatId, `✅ Bankroll → *${bankroll}€* | Mise actuelle: ${getMiseOptimale()}% (≈ ${(bankroll * getMiseOptimale() / 100).toFixed(2)}€)`, { parse_mode: "Markdown" });
});

bot.onText(/\/modeprudent (.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = match[1].toLowerCase();
    if (val === "on") {
        modePrudent = true; saveData();
        bot.sendMessage(chatId, "🛡️ Mode prudent activé manuellement.");
    } else if (val === "off") {
        modePrudent = false; saveData();
        bot.sendMessage(chatId, "✅ Mode prudent désactivé manuellement.");
    }
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
            const result = analyseMatch(match);

            if (result && result.confidence >= 70) {
                const msgAvecLigue = `🏆 ${result.league}\n\n` + result.message;
                bot.sendMessage(chatId, msgAvecLigue);
                fs.appendFileSync("history.txt", msgAvecLigue + "\n\n");

                pendingBets.push({
                    fixtureId: matchId,
                    type: result.type,
                    league: result.league,
                    timestamp: Date.now(),
                    ...result.data,
                    checked: false
                });

                sentMatches.push(matchId);
                saveData();
            }
        }
    }
}, 60000);

// ============================================================
// ⏱️ ANALYSE 60-70 MIN — toutes les minutes
// ============================================================

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
                bot.sendMessage(chatId, msgAvecLigue);
                fs.appendFileSync("history_live.txt", msgAvecLigue + "\n\n");

                resultsLive.push({
                    fixtureId: match.fixture.id,
                    goalsHomeAtSignal: match.goals.home,
                    homeName: match.teams.home.name,
                    league,
                    timestamp: Date.now(),
                    ...result.data,
                    checked: false,
                    win: null
                });

                sentMatchesLive.push(matchId);
                saveData();
            }
        }
    }
}, 60000);

// ============================================================
// 🧠 CHECK RÉSULTATS MI-TEMPS — toutes les 5 minutes
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

                console.log(`📊 RÉSULTAT MI-TEMPS → ${win ? "WIN ✅" : "LOSE ❌"}`);
                results.push({ ...bet, win, timestamp: Date.now() });
                bet.checked = true;

                // Mise à jour stats par ligue
                if (bet.league) updateLeagueStats(bet.league, win);

                // Vérification série perdante
                verifierSeriePerdante();
                saveData();
            }
        } catch (err) {
            console.log("Erreur check mi-temps:", err.message);
        }
    }
}, 300000);

// ============================================================
// 🧠 CHECK RÉSULTATS LIVE — toutes les 5 minutes
// ============================================================

setInterval(async () => {
    for (let bet of resultsLive) {
        if (bet.checked) continue;

        try {
            const res = await axios.get(
                `https://v3.football.api-sports.io/fixtures?id=${bet.fixtureId}`,
                { headers: { 'x-apisports-key': apiKey } }
            );
            const match = res.data.response[0];

            if (match.fixture.status.short === "FT") {
                const win = match.goals.home > bet.goalsHomeAtSignal;
                console.log(`⏱️ RÉSULTAT LIVE → ${win ? "WIN ✅" : "LOSE ❌"}`);
                bet.win = win;
                bet.checked = true;
                bet.timestamp = Date.now();

                if (bet.league) updateLeagueStats(bet.league, win);
                verifierSeriePerdante();
                saveData();
            }
        } catch (err) {
            console.log("Erreur check live:", err.message);
        }
    }
}, 300000);

// ============================================================
// 🧠 AUTO LEARNING — toutes les 10 minutes
// ============================================================

setInterval(() => {
    if (results.length < 10) return;
    const wins = results.filter(r => r.win);
    const losses = results.filter(r => !r.win);
    if (wins.length === 0 || losses.length === 0) return;

    const avg = (arr, key) => arr.reduce((a, b) => a + b[key], 0) / arr.length;

    if (avg(wins, "homeShots") > avg(losses, "homeShots")) minShots = Math.round(avg(wins, "homeShots"));
    if (avg(wins, "homePoss") > avg(losses, "homePoss")) minPossession = Math.round(avg(wins, "homePoss"));
    if (avg(wins, "homeXG") > avg(losses, "homeXG")) minXG = parseFloat(avg(wins, "homeXG").toFixed(1));

    saveData();
    console.log("🧠 AUTO LEARNING MI-TEMPS — Shots:", minShots, "| Poss:", minPossession, "| xG:", minXG);
}, 600000);

setInterval(() => {
    const checked = resultsLive.filter(r => r.checked && r.win !== null);
    if (checked.length < 5) return;
    const wins = checked.filter(r => r.win);
    const losses = checked.filter(r => !r.win);
    if (wins.length === 0 || losses.length === 0) return;

    const avg = (arr, key) => arr.reduce((a, b) => a + b[key], 0) / arr.length;

    if (avg(wins, "homeXG") > avg(losses, "homeXG")) minXG_live = parseFloat(((minXG_live + avg(wins, "homeXG")) / 2).toFixed(2));
    if (avg(wins, "homePoss") > avg(losses, "homePoss")) minPoss_live = Math.round((minPoss_live + avg(wins, "homePoss")) / 2);
    if (avg(wins, "homeShots") > avg(losses, "homeShots")) minShots_live = Math.round((minShots_live + avg(wins, "homeShots")) / 2);

    saveData();
    const winRate = Math.round((wins.length / checked.length) * 100);
    console.log("🧠 AUTO LEARNING LIVE — xG:", minXG_live, "| Poss:", minPoss_live, "| Tirs:", minShots_live);

    if (checked.length % 10 === 0) {
        bot.sendMessage(chatId,
            `🧠 *RAPPORT AUTO-LEARNING LIVE*\n\n📊 ${checked.length} signaux analysés\n✅ Taux: ${winRate}%\n\n🔧 Critères:\n👉 xG: ${minXG_live} | Poss: ${minPoss_live}% | Tirs: ${minShots_live}`,
            { parse_mode: "Markdown" }
        );
    }
}, 600000);

// ============================================================
// ⏰ SCHEDULERS — 10h00 récap + 23h00 bilan
// ============================================================

setInterval(() => {
    const now = new Date();
    const parisTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const h = parisTime.getHours();
    const m = parisTime.getMinutes();

    if (h === 10 && m === 0) sendDailyRecap();
    if (h === 23 && m === 0) sendNightReport();
}, 60000);

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
        console.log(`Erreur cotes fixture ${fixtureId} :`, err.message);
        return null;
    }
}

async function sendDailyRecap() {
    console.log("📅 Envoi du récap quotidien...");
    const matches = await getMatchesOfDay();
    if (matches.length === 0) {
        bot.sendMessage(chatId, "📅 Aucun match trouvé pour aujourd'hui.");
        return;
    }

    const V1_MIN = 1.90, V1_MAX = 2.50;
    const VE_MIN = 2.10, VE_MAX = 4.00;
    let filteredMatches = [];

    for (const match of matches) {
        if (!estGrandeLigue(match.league.name)) continue;

        const fixtureId = match.fixture.id;
        const home = match.teams.home.name;
        const away = match.teams.away.name;
        const league = match.league.name;
        const country = match.league.country;
        const kickoff = new Date(match.fixture.date);
        const timeStr = kickoff.toLocaleTimeString('fr-FR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris'
        });

        const odds = await getOdds(fixtureId);
        if (!odds) continue;

        const { v1, vN, ve } = odds;

        // Bonus ligue rentable
        const leagueBonus = getLeagueScore(league) >= 0.7 ? " ⭐" : "";

        if (v1 >= V1_MIN && v1 <= V1_MAX && ve >= VE_MIN && ve <= VE_MAX) {
            filteredMatches.push({ home, away, league, country, timeStr, v1, vN, ve, leagueBonus });
        }
        await new Promise(r => setTimeout(r, 200));
    }

    if (filteredMatches.length === 0) {
        bot.sendMessage(chatId, "📅 Aucun match ne correspond aux critères aujourd'hui.");
        return;
    }

    let msg = `📅 *MATCHS DU JOUR — ${new Date().toLocaleDateString('fr-FR')}*\n`;
    msg += `🏆 Grandes ligues européennes\n`;
    msg += `🎯 V1: 1.90-2.50 | V2: 2.10-4.00\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const m of filteredMatches) {
        msg += `⚽ ${m.home} vs ${m.away}${m.leagueBonus}\n`;
        msg += `🏆 ${m.league} (${m.country})\n`;
        msg += `🕐 ${m.timeStr}\n`;
        msg += `📊 V1: ${m.v1} | N: ${m.vN} | V2: ${m.ve}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    msg += `🔢 Total: ${filteredMatches.length} match(s) sélectionné(s)`;
    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    console.log(`📅 Récap envoyé — ${filteredMatches.length} match(s)`);
}
