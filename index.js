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
let minShots = 6;
let minOnTarget = 3;
let minPossession = 55;
let minXG = 1;

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

// 🤖 BOT
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