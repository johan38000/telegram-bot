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
        // Paramètres adaptatifs
        minShots, minOnTarget, minPossession, minXG,
        minXG_live, minPoss_live, minShots_live,
        // Résultats pour l'auto-learning
        results, resultsLive,
        // Historique des signaux envoyés
        sentMatches, sentMatchesLive
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
            console.log("💾 Données chargées depuis botdata.json");
        }
    } catch (err) {
        console.log("Erreur chargement données:", err.message);
    }
}

// 🔒 Éviter doublons
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

// 📊 PROBA + MISE
function getPredictionLevel(score, homeXG) {
    let probability = 50 + score * 0.3 + homeXG * 10;
    if (probability > 90) probability = 90;
    let stake = 1;
    if (probability >= 85) stake = 5;
    else if (probability >= 75) stake = 3;
    else if (probability >= 65) stake = 2;
    return { probability: Math.round(probability), stake };
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

    let score = 0;
    if (homePoss > minPossession) score += 25;
    if (homeShots >= minShots) score += 25;
    if (homeOnTarget >= minOnTarget) score += 25;
    if (homeXG >= minXG) score += 25;

    const { probability, stake } = getPredictionLevel(score, homeXG);

    // 🟢 MATCH PARFAIT
    if (homePoss >= 62 && homeShots >= 10 && homeOnTarget >= 5 && homeXG >= 1.5 && homeGoals <= awayGoals) {
        return {
            message: `🟢🟢 MATCH PARFAIT 🟢🟢\n\n⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n\n📊 ULTRA DOMINATION:\n👉 Possession: ${homePoss}%\n👉 Tirs: ${homeShots}\n👉 Cadrés: ${homeOnTarget}\n👉 xG: ${homeXG}\n\n🔥 PROBA: ${probability}%\n\n💰 MISE: ${stake}% bankroll\n\n🎯 PARI:\n👉 ${home} prochain but\n👉 Over 1.5`,
            confidence: 100, type: "perfect",
            data: { homeShots, homeOnTarget, homePoss, homeXG }
        };
    }

    // 🚨 SIGNAL PREMIUM
    if (homePoss > 60 && homeShots >= 8 && homeOnTarget >= 4 && homeXG >= 1.2 && homeGoals <= awayGoals) {
        return {
            message: `🚨 SIGNAL PREMIUM 🚨\n\n⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n\n📊 PRESSION:\n👉 ${homeShots} tirs | ${homeOnTarget} cadrés | ${homePoss}% | xG ${homeXG}\n\n🔥 PROBA: ${probability}%\n\n💰 MISE: ${stake}% bankroll\n\n🎯 PARI:\n👉 ${home} prochain but`,
            confidence: score + 10, type: "next_goal",
            data: { homeShots, homeOnTarget, homePoss, homeXG }
        };
    }

    // 🔥 VALUE BET
    if (homeGoals <= awayGoals && score >= 75) {
        return {
            message: `🔥 VALUE BET 🔥\n\n⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n\n📊 Stats:\n👉 ${homePoss}% | ${homeShots} tirs | ${homeOnTarget} cadrés | xG ${homeXG}\n\n🔥 PROBA: ${probability}%\n\n💰 MISE: ${stake}% bankroll\n\n🎯 PARI:\n👉 But ${home}\n👉 Over 1.5`,
            confidence: score, type: "over",
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

    return {
        message: `⏱️ SIGNAL LIVE 60-70' ⏱️\n\n⚽ ${home} ${homeGoals} - ${awayGoals} ${away}\n🕐 Minute: ${minute}'\n\n📊 Domination V1:\n👉 Possession: ${homePoss}%\n👉 Tirs totaux: ${homeShots}\n👉 Cadrés: ${homeOnTarget}\n👉 xG: ${homeXG} 🔬\n\n🎯 BUT PROBABLE: ${home}\n💡 Confiance: ${Math.min(confidence, 95)}%\n\n⚠️ Signal expérimental — auto-apprentissage en cours`,
        confidence, type: "live_v1",
        data: { homeShots, homeOnTarget, homePoss, homeXG }
    };
}

// ============================================================
// 🎮 MENU TELEGRAM INTERACTIF
// ============================================================

// Sécurité — uniquement ton chatId
function isAuthorized(msg) {
    return String(msg.chat.id) === String(chatId);
}

// 📋 Menu principal
function sendMainMenu() {
    const keyboard = {
        inline_keyboard: [
            [
                { text: "📊 Stats & Réglages", callback_data: "menu_stats" },
                { text: "📅 Récap du jour", callback_data: "menu_recap" }
            ],
            [
                { text: "⚙️ Modifier critères MI-TEMPS", callback_data: "menu_edit_ht" },
                { text: "⚙️ Modifier critères LIVE", callback_data: "menu_edit_live" }
            ],
            [
                { text: "📈 Historique résultats", callback_data: "menu_history" },
                { text: "🧠 Statut auto-learning", callback_data: "menu_learning" }
            ],
            [
                { text: "🔄 Réinitialiser critères", callback_data: "menu_reset" }
            ]
        ]
    };
    bot.sendMessage(chatId, "🤖 *MENU BOT PARIS*\n\nQue veux-tu faire ?", {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
}

// Commande /menu
bot.onText(/\/menu/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendMainMenu();
});

// Commande /start
bot.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg)) return;
    bot.sendMessage(chatId, "👋 Bot démarré ! Tape /menu pour accéder au panneau de contrôle.");
});

// 🎯 Gestion des boutons du menu
bot.on('callback_query', async (query) => {
    if (String(query.message.chat.id) !== String(chatId)) return;

    const data = query.data;
    bot.answerCallbackQuery(query.id);

    // 📊 STATS & RÉGLAGES ACTUELS
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
            `⏱️ Live 60-70': ${winsLive}W / ${totalLive - winsLive}L → *${tauxLive}%*`;

        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    // 📅 RÉCAP DU JOUR MANUEL
    else if (data === "menu_recap") {
        bot.sendMessage(chatId, "📅 Lancement du récap du jour...");
        sendDailyRecap();
    }

    // ⚙️ MODIFIER CRITÈRES MI-TEMPS
    else if (data === "menu_edit_ht") {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: `📉 Possession (${minPossession}%)`, callback_data: "edit_poss" }
                ],
                [
                    { text: `📉 Tirs totaux (${minShots})`, callback_data: "edit_shots" }
                ],
                [
                    { text: `📉 Tirs cadrés (${minOnTarget})`, callback_data: "edit_ontarget" }
                ],
                [
                    { text: `📉 xG minimum (${minXG})`, callback_data: "edit_xg" }
                ],
                [
                    { text: "↩️ Retour", callback_data: "menu_back" }
                ]
            ]
        };
        bot.sendMessage(chatId,
            `⚙️ *CRITÈRES MI-TEMPS*\n\nClique sur un critère pour le modifier.\nUtilise ensuite la commande correspondante:\n\n` +
            `• /setposs [valeur] — ex: /setposs 53\n` +
            `• /settirs [valeur] — ex: /settirs 6\n` +
            `• /setcadres [valeur] — ex: /setcadres 3\n` +
            `• /setxg [valeur] — ex: /setxg 0.6`,
            { parse_mode: "Markdown", reply_markup: keyboard }
        );
    }

    // ⚙️ MODIFIER CRITÈRES LIVE
    else if (data === "menu_edit_live") {
        bot.sendMessage(chatId,
            `⚙️ *CRITÈRES LIVE 60-70MIN*\n\nUtilise ces commandes:\n\n` +
            `• /setxglive [valeur] — ex: /setxglive 0.7\n` +
            `• /setposslive [valeur] — ex: /setposslive 55\n` +
            `• /settirslive [valeur] — ex: /settirslive 5\n\n` +
            `*Valeurs actuelles:*\n` +
            `👉 xG: ${minXG_live} | Possession: ${minPoss_live}% | Tirs: ${minShots_live}`,
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

    // 🧠 STATUT AUTO-LEARNING
    else if (data === "menu_learning") {
        const checkedLive = resultsLive.filter(r => r.checked);
        const winRate = checkedLive.length > 0
            ? Math.round((checkedLive.filter(r => r.win).length / checkedLive.length) * 100)
            : "—";

        const msg =
            `🧠 *STATUT AUTO-LEARNING*\n\n` +
            `*Mi-temps:*\n` +
            `👉 Matchs analysés: ${results.length}\n` +
            `👉 Prochain ajustement après: ${Math.max(0, 10 - results.length)} matchs\n\n` +
            `*Live 60-70min:*\n` +
            `👉 Signaux analysés: ${checkedLive.length}\n` +
            `👉 Taux de réussite: ${winRate}%\n` +
            `👉 Prochain ajustement après: ${Math.max(0, 5 - checkedLive.length)} signaux\n\n` +
            `💡 L'auto-learning ajuste les critères automatiquement toutes les 10 minutes.`;

        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    // 🔄 RÉINITIALISER
    else if (data === "menu_reset") {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: "✅ Confirmer reset", callback_data: "confirm_reset" },
                    { text: "❌ Annuler", callback_data: "menu_back" }
                ]
            ]
        };
        bot.sendMessage(chatId, "⚠️ Remettre tous les critères aux valeurs par défaut ?", {
            reply_markup: keyboard
        });
    }

    else if (data === "confirm_reset") {
        minShots = 5; minOnTarget = 2; minPossession = 51; minXG = 0.5;
        minXG_live = 0.6; minPoss_live = 52; minShots_live = 4;
        saveData();
        bot.sendMessage(chatId, "✅ Critères réinitialisés aux valeurs par défaut !");
    }

    // ↩️ RETOUR MENU
    else if (data === "menu_back") {
        sendMainMenu();
    }
});

// ============================================================
// 📝 COMMANDES DE MODIFICATION DES CRITÈRES
// ============================================================

// MI-TEMPS
bot.onText(/\/setposs (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 45 || val > 75) { bot.sendMessage(chatId, "❌ Valeur entre 45 et 75"); return; }
    minPossession = val;
    saveData();
    bot.sendMessage(chatId, `✅ Possession minimum → *${minPossession}%*`, { parse_mode: "Markdown" });
});

bot.onText(/\/settirs (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 1 || val > 20) { bot.sendMessage(chatId, "❌ Valeur entre 1 et 20"); return; }
    minShots = val;
    saveData();
    bot.sendMessage(chatId, `✅ Tirs minimum → *${minShots}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setcadres (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 1 || val > 10) { bot.sendMessage(chatId, "❌ Valeur entre 1 et 10"); return; }
    minOnTarget = val;
    saveData();
    bot.sendMessage(chatId, `✅ Tirs cadrés minimum → *${minOnTarget}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setxg (.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val < 0.1 || val > 3) { bot.sendMessage(chatId, "❌ Valeur entre 0.1 et 3"); return; }
    minXG = val;
    saveData();
    bot.sendMessage(chatId, `✅ xG minimum mi-temps → *${minXG}*`, { parse_mode: "Markdown" });
});

// LIVE 60-70MIN
bot.onText(/\/setxglive (.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseFloat(match[1]);
    if (isNaN(val) || val < 0.1 || val > 3) { bot.sendMessage(chatId, "❌ Valeur entre 0.1 et 3"); return; }
    minXG_live = val;
    saveData();
    bot.sendMessage(chatId, `✅ xG minimum live → *${minXG_live}*`, { parse_mode: "Markdown" });
});

bot.onText(/\/setposslive (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 45 || val > 75) { bot.sendMessage(chatId, "❌ Valeur entre 45 et 75"); return; }
    minPoss_live = val;
    saveData();
    bot.sendMessage(chatId, `✅ Possession minimum live → *${minPoss_live}%*`, { parse_mode: "Markdown" });
});

bot.onText(/\/settirslive (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 1 || val > 20) { bot.sendMessage(chatId, "❌ Valeur entre 1 et 20"); return; }
    minShots_live = val;
    saveData();
    bot.sendMessage(chatId, `✅ Tirs minimum live → *${minShots_live}*`, { parse_mode: "Markdown" });
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
                const league = match.league.name;
                const msgAvecLigue = `🏆 ${league}\n\n` + result.message;

                bot.sendMessage(chatId, msgAvecLigue);
                fs.appendFileSync("history.txt", msgAvecLigue + "\n\n");

                pendingBets.push({
                    fixtureId: matchId,
                    type: result.type,
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
                results.push({ ...bet, win });
                bet.checked = true;
                saveData();
            }
        } catch (err) {
            console.log("Erreur check mi-temps:", err.message);
        }
    }
}, 300000);

// ============================================================
// 🧠 CHECK RÉSULTATS LIVE 60-70MIN — toutes les 5 minutes
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
                const finalHomeGoals = match.goals.home;
                const win = finalHomeGoals > bet.goalsHomeAtSignal;

                console.log(`⏱️ RÉSULTAT LIVE → ${win ? "WIN ✅" : "LOSE ❌"}`);
                bet.win = win;
                bet.checked = true;
                saveData();
            }
        } catch (err) {
            console.log("Erreur check live:", err.message);
        }
    }
}, 300000);

// ============================================================
// 🧠 AUTO LEARNING MI-TEMPS — toutes les 10 minutes
// ============================================================

setInterval(() => {
    if (results.length < 10) return;

    const wins = results.filter(r => r.win);
    const losses = results.filter(r => !r.win);
    if (wins.length === 0 || losses.length === 0) return;

    const avg = (arr, key) => arr.reduce((a, b) => a + b[key], 0) / arr.length;

    const winShots = avg(wins, "homeShots");
    const loseShots = avg(losses, "homeShots");
    const winPoss = avg(wins, "homePoss");
    const losePoss = avg(losses, "homePoss");
    const winXG = avg(wins, "homeXG");
    const loseXG = avg(losses, "homeXG");

    if (winShots > loseShots) minShots = Math.round(winShots);
    if (winPoss > losePoss) minPossession = Math.round(winPoss);
    if (winXG > loseXG) minXG = parseFloat(winXG.toFixed(1));

    saveData();
    console.log("🧠 AUTO LEARNING MI-TEMPS — Shots:", minShots, "| Poss:", minPossession, "| xG:", minXG);
}, 600000);

// ============================================================
// 🧠 AUTO LEARNING LIVE 60-70MIN — toutes les 10 minutes
// ============================================================

setInterval(() => {
    const checked = resultsLive.filter(r => r.checked && r.win !== null);
    if (checked.length < 5) return;

    const wins = checked.filter(r => r.win);
    const losses = checked.filter(r => !r.win);
    if (wins.length === 0 || losses.length === 0) return;

    const avg = (arr, key) => arr.reduce((a, b) => a + b[key], 0) / arr.length;

    const winXG = avg(wins, "homeXG");
    const loseXG = avg(losses, "homeXG");
    const winPoss = avg(wins, "homePoss");
    const losePoss = avg(losses, "homePoss");
    const winShots = avg(wins, "homeShots");
    const loseShots = avg(losses, "homeShots");

    if (winXG > loseXG) minXG_live = parseFloat(((minXG_live + winXG) / 2).toFixed(2));
    if (winPoss > losePoss) minPoss_live = Math.round((minPoss_live + winPoss) / 2);
    if (winShots > loseShots) minShots_live = Math.round((minShots_live + winShots) / 2);

    saveData();

    const winRate = Math.round((wins.length / checked.length) * 100);
    console.log("🧠 AUTO LEARNING LIVE — xG:", minXG_live, "| Poss:", minPoss_live, "| Tirs:", minShots_live);

    // Notification Telegram tous les 10 signaux
    if (checked.length % 10 === 0) {
        bot.sendMessage(chatId,
            `🧠 *RAPPORT AUTO-LEARNING LIVE*\n\n` +
            `📊 Basé sur ${checked.length} signaux analysés\n` +
            `✅ Taux de réussite: ${winRate}%\n\n` +
            `🔧 *Critères mis à jour:*\n` +
            `👉 xG min: ${minXG_live}\n` +
            `👉 Possession min: ${minPoss_live}%\n` +
            `👉 Tirs min: ${minShots_live}`,
            { parse_mode: "Markdown" }
        );
    }
}, 600000);

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
        if (v1 >= V1_MIN && v1 <= V1_MAX && ve >= VE_MIN && ve <= VE_MAX) {
            filteredMatches.push({ home, away, league, country, timeStr, v1, vN, ve });
        }

        await new Promise(r => setTimeout(r, 200));
    }

    if (filteredMatches.length === 0) {
        bot.sendMessage(chatId, "📅 Aucun match ne correspond aux critères aujourd'hui.");
        return;
    }

    let msg = `📅 *MATCHS DU JOUR — ${new Date().toLocaleDateString('fr-FR')}*\n`;
    msg += `🏆 Grandes ligues européennes\n`;
    msg += `🎯 V1: 1.90-2.50 | Ve: 2.10-4.00\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const m of filteredMatches) {
        msg += `⚽ ${m.home} vs ${m.away}\n`;
        msg += `🏆 ${m.league} (${m.country})\n`;
        msg += `🕐 ${m.timeStr}\n`;
        msg += `📊 V1: ${m.v1} | N: ${m.vN} | Ve: ${m.ve}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    msg += `🔢 Total: ${filteredMatches.length} match(s) sélectionné(s)`;
    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    console.log(`📅 Récap envoyé — ${filteredMatches.length} match(s)`);
}

// ⏰ Scheduler 10h00 Paris
setInterval(() => {
    const now = new Date();
    const parisTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    if (parisTime.getHours() === 10 && parisTime.getMinutes() === 0) {
        sendDailyRecap();
    }
}, 60000);
