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
let sentMatches = [];
let pendingBets = [];
let results = [];

// 🎯 paramètres adaptatifs
let minShots = 5;
let minOnTarget = 2;
let minPossession = 51;
let minXG = 0.5;

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
            {
                headers: {
                    'x-apisports-key': apiKey
                }
            }
        );

        return response.data.response;
    } catch (err) {
        console.log("Erreur API :", err.message);
        return [];
    }
}

// 🧠 ANALYSE
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

    // 🎯 score
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

// 🤖 BOT - Analyse mi-temps
setInterval(async () => {

    const matches = await getMatches();
    const halfMatches = matches.filter(m => m.fixture.status.short === "HT");

    for (const match of halfMatches) {

        const matchId = match.fixture.id;

        if (!sentMatches.includes(matchId)) {

            const result = analyseMatch(match);

            if (result && result.confidence >= 70) {

                bot.sendMessage(chatId, result.message);

                fs.appendFileSync("history.txt", result.message + "\n\n");

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

// 🧠 CHECK RESULTATS
setInterval(async () => {

    for (let bet of pendingBets) {

        if (bet.checked) continue;

        try {
            const res = await axios.get(
                `https://v3.football.api-sports.io/fixtures?id=${bet.fixtureId}`,
                {
                    headers: {
                        'x-apisports-key': apiKey
                    }
                }
            );

            const match = res.data.response[0];

            if (match.fixture.status.short === "FT") {

                const totalGoals = match.goals.home + match.goals.away;

                let win = false;

                if (bet.type === "over" && totalGoals >= 2) win = true;
                if (bet.type === "next_goal" && totalGoals >= 2) win = true;
                if (bet.type === "perfect" && totalGoals >= 2) win = true;

                console.log(`📊 RESULTAT → ${win ? "WIN ✅" : "LOSE ❌"}`);

                results.push({ ...bet, win });

                bet.checked = true;
            }

        } catch (err) {
            console.log("Erreur check:", err.message);
        }
    }

}, 300000);

// 🧠 AUTO LEARNING
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

    console.log("🧠 AUTO LEARNING");
    console.log("Shots:", minShots);
    console.log("Possession:", minPossession);
    console.log("xG:", minXG);

}, 600000);

// ============================================================
// 📅 RÉCAP QUOTIDIEN 10H — MATCHS DU JOUR AVEC COTES V1 / Ve
// ============================================================

// 📡 Récupère les matchs du jour
async function getMatchesOfDay() {
    try {
        const today = new Date().toISOString().split('T')[0]; // format YYYY-MM-DD
        const response = await axios.get(
            `https://v3.football.api-sports.io/fixtures?date=${today}`,
            {
                headers: { 'x-apisports-key': apiKey }
            }
        );
        return response.data.response;
    } catch (err) {
        console.log("Erreur getMatchesOfDay :", err.message);
        return [];
    }
}

// 📡 Récupère les cotes d'un match (bookmaker = 1 → bet365 par défaut)
async function getOdds(fixtureId) {
    try {
        const response = await axios.get(
            `https://v3.football.api-sports.io/odds?fixture=${fixtureId}&bookmaker=1`,
            {
                headers: { 'x-apisports-key': apiKey }
            }
        );

        const data = response.data.response;
        if (!data || data.length === 0) return null;

        // On cherche le marché "Match Winner" (1X2)
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

// 📨 Envoi du récap 10h
async function sendDailyRecap() {
    console.log("📅 Envoi du récap quotidien...");

    const matches = await getMatchesOfDay();

    if (matches.length === 0) {
        bot.sendMessage(chatId, "📅 Aucun match trouvé pour aujourd'hui.");
        return;
    }

    // On filtre les matchs avec les bonnes cotes
    // V1 entre 1.90 et 2.50  →  match équilibré légèrement en faveur domicile
    // Ve entre 2.10 et 4.00  →  victoire extérieure possible mais pas écrasante
    const V1_MIN = 1.90;
    const V1_MAX = 2.50;
    const VE_MIN = 2.10;
    const VE_MAX = 4.00;

    let filteredMatches = [];

    for (const match of matches) {
        const fixtureId = match.fixture.id;
        const home = match.teams.home.name;
        const away = match.teams.away.name;
        const league = match.league.name;
        const country = match.league.country;

        // Heure du match (UTC → on affiche telle quelle, Railway tourne en UTC)
        const kickoff = new Date(match.fixture.date);
        const timeStr = kickoff.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Paris'
        });

        const odds = await getOdds(fixtureId);

        if (!odds) continue;

        const { v1, vN, ve } = odds;

        // Filtre sur les cotes
        const v1Ok = v1 >= V1_MIN && v1 <= V1_MAX;
        const veOk = ve >= VE_MIN && ve <= VE_MAX;

        if (v1Ok && veOk) {
            filteredMatches.push({ home, away, league, country, timeStr, v1, vN, ve });
        }

        // Petite pause pour ne pas surcharger l'API
        await new Promise(r => setTimeout(r, 200));
    }

    if (filteredMatches.length === 0) {
        bot.sendMessage(chatId, "📅 Aucun match ne correspond aux critères de cotes aujourd'hui (V1: 1.90-2.50 / Ve: 2.10-4.00).");
        return;
    }

    // Construction du message
    let msg = `📅 MATCHS DU JOUR — ${new Date().toLocaleDateString('fr-FR')}\n`;
    msg += `🎯 Critères: V1 entre 1.90-2.50 | Ve entre 2.10-4.00\n`;
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

// ⏰ Scheduler 10h00 (heure de Paris)
// Vérifie toutes les minutes si on est à 10h00
setInterval(() => {
    const now = new Date();
    const parisTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const hours = parisTime.getHours();
    const minutes = parisTime.getMinutes();

    if (hours === 10 && minutes === 0) {
        sendDailyRecap();
    }
}, 60000);
