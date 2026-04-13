require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.API_KEY;
const chatId = "1633310404";

const bot = new TelegramBot(token, { polling: true });

console.log("🔥 BOT FINAL LANCÉ");

// 🔒 éviter doublons
let sentMatches = [];       // matchs mi-temps déjà envoyés
let sentMatchesLive = [];   // matchs 60-70min déjà envoyés
let pendingBets = [];
let results = [];
let resultsLive = [];       // résultats spécifiques aux signaux 60-70min

// 🎯 paramètres adaptatifs — mi-temps
let minShots = 5;
let minOnTarget = 2;
let minPossession = 51;
let minXG = 0.5;

// 🎯 paramètres adaptatifs — signal 60-70min (auto-learning séparé)
let minXG_live = 0.6;
let minPoss_live = 52;
let minShots_live = 4;

// 🏆 FILTRE GRANDES LIGUES EUROPÉENNES
const GRANDES_LIGUES = [
    "Premier League",
    "La Liga",
    "Serie A",
    "Bundesliga",
    "Ligue 1",
    "Eredivisie",
    "Primeira Liga",
    "Champions League",
    "Europa League",
    "Conference League",
    "Championship",
    "Serie B",
    "2. Bundesliga",
    "Ligue 2",
    "La Liga2"
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
    else stake = 1;

    return {
        probability: Math.round(probability),
        stake
    };
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
    const perfectMatch =
        homePoss >= 62 &&
        homeShots >= 10 &&
        homeOnTarget >= 5 &&
        homeXG >= 1.5;

    if (perfectMatch && homeGoals <= awayGoals) {
        return {
            message: `🟢🟢 MATCH PARFAIT 🟢🟢

⚽ ${home} ${homeGoals} - ${awayGoals} ${away}

📊 ULTRA DOMINATION:
👉 Possession: ${homePoss}%
👉 Tirs: ${homeShots}
👉 Cadrés: ${homeOnTarget}
👉 xG: ${homeXG}

🔥 PROBA: ${probability}%

💰 MISE: ${stake}% bankroll

🎯 PARI:
👉 ${home} prochain but
👉 Over 1.5`,
            confidence: 100,
            type: "perfect",
            data: { homeShots, homeOnTarget, homePoss, homeXG }
        };
    }

    // 🚨 NEXT GOAL
    const nextGoalStrong =
        homePoss > 60 &&
        homeShots >= 8 &&
        homeOnTarget >= 4 &&
        homeXG >= 1.2;

    if (nextGoalStrong && homeGoals <= awayGoals) {
        return {
            message: `🚨 SIGNAL PREMIUM 🚨

⚽ ${home} ${homeGoals} - ${awayGoals} ${away}

📊 PRESSION:
👉 ${homeShots} tirs | ${homeOnTarget} cadrés | ${homePoss}% | xG ${homeXG}

🔥 PROBA: ${probability}%

💰 MISE: ${stake}% bankroll

🎯 PARI:
👉 ${home} prochain but`,
            confidence: score + 10,
            type: "next_goal",
            data: { homeShots, homeOnTarget, homePoss, homeXG }
        };
    }

    // 🔥 VALUE
    if ((homeGoals <= awayGoals) && score >= 75) {
        return {
            message: `🔥 VALUE BET 🔥

⚽ ${home} ${homeGoals} - ${awayGoals} ${away}

📊 Stats:
👉 ${homePoss}% | ${homeShots} tirs | ${homeOnTarget} cadrés | xG ${homeXG}

🔥 PROBA: ${probability}%

💰 MISE: ${stake}% bankroll

🎯 PARI:
👉 But ${home}
👉 Over 1.5`,
            confidence: score,
            type: "over",
            data: { homeShots, homeOnTarget, homePoss, homeXG }
        };
    }

    return null;
}

// ⏱️ ANALYSE 60-70 MIN — But probable V1
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

    // Critères adaptatifs — appris par auto-learning
    const conditionOk =
        homeXG >= minXG_live &&
        homePoss >= minPoss_live &&
        homeShots >= minShots_live;

    if (!conditionOk) return null;

    let confidence = 0;
    if (homeXG >= minXG_live) confidence += 40;
    if (homePoss >= minPoss_live) confidence += 30;
    if (homeShots >= minShots_live) confidence += 30;
    if (homeOnTarget >= 2) confidence += 10;

    return {
        message: `⏱️ SIGNAL LIVE 60-70' ⏱️

⚽ ${home} ${homeGoals} - ${awayGoals} ${away}
🕐 Minute: ${minute}'

📊 Domination V1:
👉 Possession: ${homePoss}%
👉 Tirs totaux: ${homeShots}
👉 Cadrés: ${homeOnTarget}
👉 xG: ${homeXG} 🔬

🎯 BUT PROBABLE: ${home}
💡 Confiance: ${Math.min(confidence, 95)}%

⚠️ Signal expérimental — auto-apprentissage en cours`,
        confidence,
        type: "live_v1",
        data: { homeShots, homeOnTarget, homePoss, homeXG }
    };
}

// 🤖 BOT - Analyse MI-TEMPS (grandes ligues uniquement)
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
            }
        }
    }

}, 60000);

// ⏱️ BOT - Analyse 60-70 MIN (grandes ligues uniquement)
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
                    goalsAwayAtSignal: match.goals.away,
                    homeName: match.teams.home.name,
                    ...result.data,
                    checked: false,
                    win: null
                });

                sentMatchesLive.push(matchId);
            }
        }
    }

}, 60000);

// 🧠 CHECK RESULTATS MI-TEMPS
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

                console.log(`📊 RESULTAT MI-TEMPS → ${win ? "WIN ✅" : "LOSE ❌"}`);
                results.push({ ...bet, win });
                bet.checked = true;
            }

        } catch (err) {
            console.log("Erreur check mi-temps:", err.message);
        }
    }

}, 300000);

// 🧠 CHECK RESULTATS LIVE 60-70MIN
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
                // WIN si l'équipe domicile a marqué au moins 1 but après le signal
                const finalHomeGoals = match.goals.home;
                const win = finalHomeGoals > bet.goalsHomeAtSignal;

                console.log(`⏱️ RESULTAT LIVE → ${win ? "WIN ✅" : "LOSE ❌"}`);
                bet.win = win;
                bet.checked = true;
            }

        } catch (err) {
            console.log("Erreur check live:", err.message);
        }
    }

}, 300000);

// 🧠 AUTO LEARNING — MI-TEMPS
setInterval(() => {

    if (results.length < 10) return;

    const wins = results.filter(r => r.win);
    const losses = results.filter(r => !r.win);

    const avg = (arr, key) =>
        arr.reduce((a, b) => a + b[key], 0) / arr.length;

    const winShots = avg(wins, "homeShots");
    const loseShots = avg(losses, "homeShots");
    const winPoss = avg(wins, "homePoss");
    const losePoss = avg(losses, "homePoss");
    const winXG = avg(wins, "homeXG");
    const loseXG = avg(losses, "homeXG");

    if (winShots > loseShots) minShots = Math.round(winShots);
    if (winPoss > losePoss) minPossession = Math.round(winPoss);
    if (winXG > loseXG) minXG = parseFloat(winXG.toFixed(1));

    console.log("🧠 AUTO LEARNING MI-TEMPS");
    console.log("Shots:", minShots, "| Possession:", minPossession, "| xG:", minXG);

}, 600000);

// 🧠 AUTO LEARNING — SIGNAL LIVE 60-70MIN
setInterval(() => {

    const checked = resultsLive.filter(r => r.checked && r.win !== null);
    if (checked.length < 5) return;

    const wins = checked.filter(r => r.win);
    const losses = checked.filter(r => !r.win);

    if (wins.length === 0 || losses.length === 0) return;

    const avg = (arr, key) =>
        arr.reduce((a, b) => a + b[key], 0) / arr.length;

    const winXG = avg(wins, "homeXG");
    const loseXG = avg(losses, "homeXG");
    const winPoss = avg(wins, "homePoss");
    const losePoss = avg(losses, "homePoss");
    const winShots = avg(wins, "homeShots");
    const loseShots = avg(losses, "homeShots");

    // Ajustement progressif par petits pas
    if (winXG > loseXG) {
        minXG_live = parseFloat(((minXG_live + winXG) / 2).toFixed(2));
    }
    if (winPoss > losePoss) {
        minPoss_live = Math.round((minPoss_live + winPoss) / 2);
    }
    if (winShots > loseShots) {
        minShots_live = Math.round((minShots_live + winShots) / 2);
    }

    const winRate = Math.round((wins.length / checked.length) * 100);

    console.log("🧠 AUTO LEARNING LIVE 60-70MIN");
    console.log(`xG min: ${minXG_live} | Possession min: ${minPoss_live}% | Tirs min: ${minShots_live}`);
    console.log(`Taux de réussite: ${winRate}% (${wins.length}W / ${losses.length}L)`);

    // Notification Telegram tous les 10 signaux analysés
    if (checked.length % 10 === 0) {
        bot.sendMessage(chatId,
            `🧠 RAPPORT AUTO-LEARNING LIVE\n\n` +
            `📊 Basé sur ${checked.length} signaux analysés\n` +
            `✅ Taux de réussite: ${winRate}%\n\n` +
            `🔧 Critères mis à jour:\n` +
            `👉 xG min: ${minXG_live}\n` +
            `👉 Possession min: ${minPoss_live}%\n` +
            `👉 Tirs min: ${minShots_live}`
        );
    }

}, 600000);

// ============================================================
// 📅 RÉCAP QUOTIDIEN 10H — MATCHS DU JOUR AVEC COTES V1 / Ve
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

        // Grandes ligues uniquement pour le récap aussi
        if (!estGrandeLigue(match.league.name)) continue;

        const fixtureId = match.fixture.id;
        const home = match.teams.home.name;
        const away = match.teams.away.name;
        const league = match.league.name;
        const country = match.league.country;

        const kickoff = new Date(match.fixture.date);
        const timeStr = kickoff.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Paris'
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

    let msg = `📅 MATCHS DU JOUR — ${new Date().toLocaleDateString('fr-FR')}\n`;
    msg += `🏆 Grandes ligues européennes uniquement\n`;
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

    bot.sendMessage(chatId, msg);
    console.log(`📅 Récap envoyé — ${filteredMatches.length} match(s)`);
}

// ⏰ Scheduler 10h00 Paris
setInterval(() => {
    const now = new Date();
    const parisTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const hours = parisTime.getHours();
    const minutes = parisTime.getMinutes();

    if (hours === 10 && minutes === 0) {
        sendDailyRecap();
    }
}, 60000);
