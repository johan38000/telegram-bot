require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.API_KEY;
const oddsApiKey = process.env.ODDS_API_KEY;
const chatId = "1633310404";

const bot = new TelegramBot(token, {
    polling: {
        autoStart: false,
        params: { timeout: 10 }
    }
});

// Démarrage propre — évite le bug 409
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

console.log("🔥 BOT LANCÉ");

// ============================================================
// 💾 SAUVEGARDE / CHARGEMENT
// ============================================================

const DATA_FILE = 'botdata.json';

function saveData() {
    const data = {
        results,
        sentSignals,
        leagueStats,
        bankroll,
        modePrudent,
        matchsSuivis
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            results = data.results ?? [];
            sentSignals = data.sentSignals ?? [];
            leagueStats = data.leagueStats ?? {};
            bankroll = data.bankroll ?? 100;
            modePrudent = data.modePrudent ?? false;
            matchsSuivis = data.matchsSuivis ?? {};
            console.log("💾 Données chargées");
        }
    } catch (err) {
        console.log("Erreur chargement:", err.message);
    }
}

// ============================================================
// 🔒 VARIABLES GLOBALES
// ============================================================

let results = [];          // Historique des paris avec résultats
let sentSignals = [];      // Signaux déjà envoyés (éviter doublons)
let leagueStats = {};      // Stats par ligue
let bankroll = 100;        // Bankroll de référence
let modePrudent = false;   // Mode prudent si série perdante

// Matchs suivis { fixtureId: { v1Odds, v2Odds, homeTeam, awayTeam, league, goalsHome, goalsAway, signalEnvoye } }
let matchsSuivis = {};

// Paris en attente de résultat
let pendingResults = [];

loadData();

// ============================================================
// 💰 GESTION BANKROLL AUTOMATIQUE
// ============================================================

function getMiseOptimale() {
    const derniers = results.filter(r => r.prisParUtilisateur).slice(-10);
    if (derniers.length < 3) return 1;
    const taux = derniers.filter(r => r.win).length / derniers.length;
    if (modePrudent) return 0.5;
    if (taux >= 0.8) return 3;
    if (taux >= 0.65) return 2;
    if (taux >= 0.5) return 1;
    return 0.5;
}

function verifierSeriePerdante() {
    const derniers = results.filter(r => r.prisParUtilisateur).slice(-3);
    if (derniers.length < 3) return;
    if (derniers.every(r => !r.win) && !modePrudent) {
        modePrudent = true;
        saveData();
        bot.sendMessage(chatId,
            `⚠️ *MODE PRUDENT ACTIVÉ*\n\n3 paris perdants consécutifs.\n🛡️ Mises réduites à 0.5%.\n/modeprudent off pour désactiver.`,
            { parse_mode: "Markdown" }
        );
    }
    const deuxDerniers = results.filter(r => r.prisParUtilisateur).slice(-2);
    if (deuxDerniers.length === 2 && deuxDerniers.every(r => r.win) && modePrudent) {
        modePrudent = false;
        saveData();
        bot.sendMessage(chatId, `✅ *MODE PRUDENT DÉSACTIVÉ* — 2 wins ! 🔥`, { parse_mode: "Markdown" });
    }
}

function updateLeagueStats(league, win) {
    if (!leagueStats[league]) leagueStats[league] = { wins: 0, total: 0 };
    leagueStats[league].total++;
    if (win) leagueStats[league].wins++;
    saveData();
}

// ============================================================
// 🏆 GRANDES LIGUES
// ============================================================

const GRANDES_LIGUES = [
    // Angleterre
    "Premier League", "Championship", "FA Cup", "EFL Cup",
    // Espagne
    "La Liga", "La Liga2", "Copa del Rey",
    // Italie
    "Serie A", "Serie B", "Coppa Italia",
    // Allemagne
    "Bundesliga", "2. Bundesliga", "DFB Pokal",
    // France
    "Ligue 1", "Ligue 2", "Coupe de France",
    // Pays-Bas
    "Eredivisie", "Eerste Divisie",
    // Portugal
    "Primeira Liga", "Liga Portugal 2",
    // UEFA
    "Champions League", "Europa League", "Conference League",
    // Belgique
    "First Division A", "Pro League",
    // Turquie
    "Super Lig",
    // Ecosse
    "Premiership"
];

function estGrandeLigue(leagueName) {
    return GRANDES_LIGUES.some(l =>
        leagueName.toLowerCase().includes(l.toLowerCase())
    );
}

// ============================================================
// 🔥 API MATCHS LIVE
// ============================================================

async function getMatchesLive() {
    try {
        const response = await axios.get(
            'https://v3.football.api-sports.io/fixtures?live=all',
            { headers: { 'x-apisports-key': apiKey } }
        );
        return response.data.response;
    } catch (err) {
        console.log("Erreur API live:", err.message);
        return [];
    }
}

async function getMatchesOfDay() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const response = await axios.get(
            `https://v3.football.api-sports.io/fixtures?date=${today}`,
            { headers: { 'x-apisports-key': apiKey } }
        );
        return response.data.response;
    } catch (err) {
        console.log("Erreur API jour:", err.message);
        return [];
    }
}

async function getOdds(fixtureId) {
    try {
        // Bookmaker 1xbet = ID 8 sur api-football
        const response = await axios.get(
            `https://v3.football.api-sports.io/odds?fixture=${fixtureId}&bookmaker=8`,
            { headers: { 'x-apisports-key': apiKey } }
        );
        const data = response.data.response;

        // Si 1xbet pas disponible → fallback sur bookmaker 1 (bet365)
        let bookmakerData = data?.[0]?.bookmakers?.find(b => b.id === 8);
        if (!bookmakerData) {
            const response2 = await axios.get(
                `https://v3.football.api-sports.io/odds?fixture=${fixtureId}&bookmaker=1`,
                { headers: { 'x-apisports-key': apiKey } }
            );
            const data2 = response2.data.response;
            bookmakerData = data2?.[0]?.bookmakers?.[0];
        }
        if (!bookmakerData) return null;

        // Cote Match Winner (V1/N/V2)
        const marketWinner = bookmakerData.bets.find(b => b.name === "Match Winner");
        if (!marketWinner) return null;
        const v1 = parseFloat(marketWinner.values.find(v => v.value === "Home")?.odd);
        const vN = parseFloat(marketWinner.values.find(v => v.value === "Draw")?.odd);
        const v2 = parseFloat(marketWinner.values.find(v => v.value === "Away")?.odd);

        return { v1, vN, v2, bookmakerName: bookmakerData.name };
    } catch (err) {
        return null;
    }
}

// Récupère la cote "Next Goal" V1 via The Odds API
async function getNextGoalOdds(fixtureId, homeTeam) {
    try {
        if (!oddsApiKey) return null;

        // The Odds API — marché "next_goal" ou "h2h" selon disponibilité
        // On cherche d'abord avec le nom des équipes via l'API football pour avoir le sport_event_id
        const response = await axios.get(
            `https://api.the-odds-api.com/v4/sports/soccer/odds/`,
            {
                params: {
                    apiKey: oddsApiKey,
                    regions: 'eu',
                    markets: 'h2h,next_goal',
                    oddsFormat: 'decimal',
                    bookmakers: 'onexbet,bet365,unibet'
                }
            }
        );

        const games = response.data;
        if (!games || games.length === 0) return null;

        // Chercher le match par nom d'équipe domicile
        const game = games.find(g =>
            g.home_team?.toLowerCase().includes(homeTeam.toLowerCase()) ||
            homeTeam.toLowerCase().includes(g.home_team?.toLowerCase())
        );

        if (!game) return null;

        // Chercher le marché "next_goal"
        for (const bookmaker of game.bookmakers) {
            const nextGoalMarket = bookmaker.markets.find(m =>
                m.key === "next_goal" ||
                m.key === "next_team_to_score"
            );

            if (nextGoalMarket) {
                const homeOutcome = nextGoalMarket.outcomes.find(o =>
                    o.name === "Home" ||
                    o.name?.toLowerCase().includes(homeTeam.toLowerCase())
                );

                if (homeOutcome) {
                    return {
                        cote: parseFloat(homeOutcome.price.toFixed(2)),
                        bookmaker: bookmaker.title,
                        marche: "Prochain but V1"
                    };
                }
            }

            // Fallback — cote victoire V1 si next_goal pas dispo
            const h2hMarket = bookmaker.markets.find(m => m.key === "h2h");
            if (h2hMarket) {
                const homeOutcome = h2hMarket.outcomes.find(o => o.name === "Home" || o.name === game.home_team);
                if (homeOutcome) {
                    return {
                        cote: parseFloat(homeOutcome.price.toFixed(2)),
                        bookmaker: bookmaker.title,
                        marche: "Victoire V1 (next goal indispo)"
                    };
                }
            }
        }

        return null;
    } catch (err) {
        console.log("Erreur The Odds API:", err.message);
        return null;
    }
}

// ============================================================
// 📅 RÉCAP QUOTIDIEN 10H
// ============================================================

async function sendDailyRecap() {
    console.log("📅 Envoi récap quotidien...");
    const matches = await getMatchesOfDay();
    if (matches.length === 0) {
        bot.sendMessage(chatId, "📅 Aucun match trouvé pour aujourd'hui.");
        return;
    }

    const V1_MIN = 1.90, V1_MAX = 2.50;
    const V2_MIN = 2.10, V2_MAX = 4.00;
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

        const { v1, vN, v2 } = odds;

        if (v1 >= V1_MIN && v1 <= V1_MAX && v2 >= V2_MIN && v2 <= V2_MAX) {
            // Enregistrer ce match pour surveillance pendant le jeu
            matchsSuivis[fixtureId] = {
                fixtureId, home, away, league, v1, vN, v2,
                goalsHome: 0, goalsAway: 0,
                signalEnvoye: false
            };

            const leagueBonus = leagueStats[league]?.total >= 3
                ? Math.round((leagueStats[league].wins / leagueStats[league].total) * 100) >= 70 ? " ⭐" : ""
                : "";

            filteredMatches.push({ home, away, league, country, timeStr, v1, vN, v2, leagueBonus });
        }
        await new Promise(r => setTimeout(r, 200));
    }

    saveData();

    if (filteredMatches.length === 0) {
        bot.sendMessage(chatId, "📅 Aucun match ne correspond aux critères aujourd'hui.");
        return;
    }

    let msg = `📅 *MATCHS DU JOUR — ${new Date().toLocaleDateString('fr-FR')}*\n`;
    msg += `🏆 Grandes ligues européennes\n`;
    msg += `🎯 V1: 1.90-2.50 | V2: 2.10-4.00\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const m of filteredMatches) {
        msg += `⚽ *${m.home}* vs ${m.away}${m.leagueBonus}\n`;
        msg += `🏆 ${m.league} (${m.country})\n`;
        msg += `🕐 ${m.timeStr}\n`;
        msg += `📊 V1: ${m.v1} | N: ${m.vN} | V2: ${m.v2}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    msg += `🔢 ${filteredMatches.length} match(s) — je surveille les buts de V2 en direct !`;
    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    console.log(`📅 Récap envoyé — ${filteredMatches.length} match(s) surveillés`);
}

// ============================================================
// 👁️ SURVEILLANCE BUTS V2 — toutes les minutes
// ============================================================

setInterval(async () => {
    const matchIds = Object.keys(matchsSuivis);
    if (matchIds.length === 0) return;

    const matches = await getMatchesLive();

    for (const match of matches) {
        const fixtureId = match.fixture.id;
        const suivi = matchsSuivis[fixtureId];
        if (!suivi) continue;

        const goalsHome = match.goals.home ?? 0;
        const goalsAway = match.goals.away ?? 0;
        const minute = match.fixture.status.elapsed || 0;
        const statut = match.fixture.status.short;

        // Match terminé — vérifier résultat
        if (statut === "FT") {
            // Chercher les paris en attente pour ce match
            const betsForMatch = pendingResults.filter(b => b.fixtureId === fixtureId && !b.checked);
            for (let bet of betsForMatch) {
                // WIN = V1 a marqué au moins 1 but après le signal
                const win = goalsHome > bet.goalsHomeAtSignal;
                bet.checked = true;

                // Vérifier si V1 a bien marqué après le signal
                const v1AMarque = goalsHome > bet.goalsHomeAtSignal;

                if (bet.prisParUtilisateur) {
                    let msg = `${win ? "✅ WIN !" : "❌ LOSE"}

`;
                    msg += `⚽ *${suivi.home}* vs *${suivi.away}*
`;
                    msg += `📊 Score final: *${goalsHome} - ${goalsAway}*
`;
                    msg += `📊 V1 de départ: ${suivi.v1} | V2: ${suivi.v2}

`;
                    msg += `${v1AMarque ? `🎯 V1 (${suivi.home}) a bien marqué !` : `❌ V1 (${suivi.home}) n'a pas marqué`}

`;
                    msg += `${win ? "🎉 Bien joué !" : "😕 Pas de chance, on continue !"}`;
                    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
                } else {
                    let msg = `📊 *Résultat — pari refusé:*

`;
                    msg += `⚽ *${suivi.home}* vs *${suivi.away}*
`;
                    msg += `📊 Score final: *${goalsHome} - ${goalsAway}*

`;
                    msg += `${v1AMarque ? `🎯 V1 (${suivi.home}) a marqué` : `❌ V1 (${suivi.home}) n'a pas marqué`}
`;
                    msg += `${win ? "✅ Aurait été un WIN 🤔" : "✅ Bonne décision de passer !"}`;
                    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
                }

                // Enregistrer le résultat dans l'historique
                const resultEntry = {
                    fixtureId,
                    home: suivi.home,
                    away: suivi.away,
                    league: suivi.league,
                    v1: suivi.v1,
                    v2: suivi.v2,
                    coteNextGoal: bet.coteNextGoal || null,
                    goalsHomeAtSignal: bet.goalsHomeAtSignal,
                    goalsFinal: goalsHome,
                    scoreFinal: `${goalsHome}-${goalsAway}`,
                    minuteSignal: bet.minuteSignal,
                    prisParUtilisateur: bet.prisParUtilisateur,
                    v1AMarque,
                    win,
                    timestamp: Date.now()
                };

                results.push(resultEntry);
                console.log(`📊 Résultat enregistré: ${suivi.home} vs ${suivi.away} — ${win ? "WIN ✅" : "LOSE ❌"} — Pris: ${bet.prisParUtilisateur}`);

                // Mettre à jour stats uniquement sur les paris pris
                if (bet.prisParUtilisateur) {
                    updateLeagueStats(suivi.league, win);
                    verifierSeriePerdante();
                }
            }

            // Nettoyer le match suivi
            delete matchsSuivis[fixtureId];
            saveData();
            continue;
        }

        // ── Détection but V2 — uniquement si score passe à 0-1 ──
        const butV2Detecte = goalsAway > suivi.goalsAway;
        const scoreEstZeroUn = goalsHome === 0 && goalsAway === 1;

        if (butV2Detecte && scoreEstZeroUn && !suivi.signalEnvoye) {
            suivi.signalEnvoye = true;
            suivi.goalsHome = goalsHome;
            suivi.goalsAway = goalsAway;
            saveData();

            // Envoyer le signal
            const mise = getMiseOptimale();
            const signalKey = `${fixtureId}_${goalsAway}`;

            if (!sentSignals.includes(signalKey)) {
                sentSignals.push(signalKey);

                const leagueInfo = leagueStats[suivi.league]?.total >= 3
                    ? `📈 ${suivi.league}: ${Math.round((leagueStats[suivi.league].wins / leagueStats[suivi.league].total) * 100)}% de réussite historique`
                    : `📊 ${suivi.league}: pas encore d'historique`;

                let msg = `🚨 *SIGNAL — BUT DE V2 !* 🚨\n\n`;
                msg += `⚽ *${suivi.home}* ${goalsHome} - ${goalsAway} *${suivi.away}*\n`;
                msg += `🕐 Minute: ${minute}'\n\n`;
                msg += `📊 *Cotes:*\n`;
                msg += `👉 V1 (${suivi.home}): ${suivi.v1}\n`;
                msg += `👉 N: ${suivi.vN}\n`;
                msg += `👉 V2 (${suivi.away}): ${suivi.v2}\n\n`;
                msg += `${leagueInfo}\n\n`;
                // Récupérer la cote "Next Goal V1" au moment du signal
                let coteNextGoal = null;
                let coteSource = "";
                try {
                    const nextGoalData = await getNextGoalOdds(fixtureId, suivi.home);
                    if (nextGoalData) {
                        coteNextGoal = nextGoalData.cote;
                        coteSource = nextGoalData.bookmaker;
                    }
                } catch(e) {}

                msg += `🎯 *PARI: ${suivi.home} marque le prochain but*\n`;
                if (coteNextGoal) {
                    msg += `📈 Cote "Prochain but V1": *${coteNextGoal}* (${coteSource})\n\n`;
                } else {
                    msg += `📈 Cote non disponible via API — consulte directement 1xbet ou ton bookmaker\n\n`;
                }
                msg += `💡 V1 va pousser pour égaliser !\n\n`;
                msg += `👇 *Tu prends ce pari ?*`;

                const keyboard = {
                    inline_keyboard: [[
                        { text: "✅ OUI je prends", callback_data: `pari_oui_${fixtureId}_${goalsAway}` },
                        { text: "❌ NON je passe", callback_data: `pari_non_${fixtureId}_${goalsAway}` }
                    ]]
                };

                bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: keyboard });
                fs.appendFileSync("history.txt", msg + "\n\n");

                // Enregistrer pour suivi résultat APRÈS envoi du message
                pendingResults.push({
                    fixtureId,
                    goalsHomeAtSignal: goalsHome,
                    minuteSignal: minute,
                    coteNextGoal: coteNextGoal || null,
                    prisParUtilisateur: null,
                    checked: false
                });

                saveData();
                console.log(`🚨 Signal envoyé: ${suivi.home} vs ${suivi.away} — but V2 à ${minute}'`);
            }
        }

        // ── Si V2 marque un 2ème but → LOSE immédiat ──
        // V1 n'a pas marqué le prochain but
        if (suivi.signalEnvoye && goalsAway > suivi.goalsAway) {
            const betsForMatch = pendingResults.filter(b => b.fixtureId === fixtureId && !b.checked);
            for (let bet of betsForMatch) {
                if (bet.prisParUtilisateur === null) continue; // pas encore de décision
                bet.checked = true;

                if (bet.prisParUtilisateur) {
                    bot.sendMessage(chatId,
                        `❌ *LOSE — V2 a marqué en premier !*

` +
                        `⚽ *${suivi.home}* ${goalsHome} - ${goalsAway} *${suivi.away}*
` +
                        `🕐 Minute: ${minute}'

` +
                        `❌ V1 n'a pas marqué le prochain but
` +
                        `😕 Pas de chance, on continue !`,
                        { parse_mode: "Markdown" }
                    );
                } else {
                    bot.sendMessage(chatId,
                        `📊 *Résultat — pari refusé:*

` +
                        `⚽ *${suivi.home}* ${goalsHome} - ${goalsAway} *${suivi.away}*
` +
                        `❌ V2 a marqué en premier — aurait été un LOSE
` +
                        `✅ Bonne décision de passer !`,
                        { parse_mode: "Markdown" }
                    );
                }

                results.push({
                    fixtureId,
                    home: suivi.home,
                    away: suivi.away,
                    league: suivi.league,
                    v1: suivi.v1,
                    v2: suivi.v2,
                    coteNextGoal: bet.coteNextGoal || null,
                    goalsHomeAtSignal: bet.goalsHomeAtSignal,
                    goalsFinal: goalsHome,
                    scoreFinal: `${goalsHome}-${goalsAway}`,
                    minuteSignal: bet.minuteSignal,
                    prisParUtilisateur: bet.prisParUtilisateur,
                    v1AMarque: false,
                    win: false,
                    loseRaison: "V2 a marqué en premier",
                    timestamp: Date.now()
                });

                if (bet.prisParUtilisateur) {
                    updateLeagueStats(suivi.league, false);
                    verifierSeriePerdante();
                }

                saveData();
            }
        }

        // ── Si V1 marque → WIN immédiat ──
        if (suivi.signalEnvoye && goalsHome > suivi.goalsHome) {
            const betsForMatch = pendingResults.filter(b => b.fixtureId === fixtureId && !b.checked);
            for (let bet of betsForMatch) {
                if (bet.prisParUtilisateur === null) continue;
                bet.checked = true;

                if (bet.prisParUtilisateur) {
                    bot.sendMessage(chatId,
                        `✅ *WIN — V1 a marqué !*

` +
                        `⚽ *${suivi.home}* ${goalsHome} - ${goalsAway} *${suivi.away}*
` +
                        `🕐 Minute: ${minute}'

` +
                        `🎯 V1 (${suivi.home}) a marqué le prochain but !
` +
                        `🎉 Bien joué !`,
                        { parse_mode: "Markdown" }
                    );
                } else {
                    bot.sendMessage(chatId,
                        `📊 *Résultat — pari refusé:*

` +
                        `⚽ *${suivi.home}* ${goalsHome} - ${goalsAway} *${suivi.away}*
` +
                        `✅ V1 a marqué — aurait été un WIN
` +
                        `🤔 A retenir pour la prochaine fois !`,
                        { parse_mode: "Markdown" }
                    );
                }

                results.push({
                    fixtureId,
                    home: suivi.home,
                    away: suivi.away,
                    league: suivi.league,
                    v1: suivi.v1,
                    v2: suivi.v2,
                    coteNextGoal: bet.coteNextGoal || null,
                    goalsHomeAtSignal: bet.goalsHomeAtSignal,
                    goalsFinal: goalsHome,
                    scoreFinal: `${goalsHome}-${goalsAway}`,
                    minuteSignal: bet.minuteSignal,
                    prisParUtilisateur: bet.prisParUtilisateur,
                    v1AMarque: true,
                    win: true,
                    timestamp: Date.now()
                });

                if (bet.prisParUtilisateur) {
                    updateLeagueStats(suivi.league, true);
                    verifierSeriePerdante();
                }

                saveData();
            }
        }

        // Mettre à jour le score suivi
        suivi.goalsHome = goalsHome;
        suivi.goalsAway = goalsAway;
    }
}, 60000);

// ============================================================
// 🎮 GESTION BOUTONS OUI / NON
// ============================================================

bot.on('callback_query', async (query) => {
    if (String(query.message.chat.id) !== String(chatId)) return;
    const data = query.data;
    bot.answerCallbackQuery(query.id);

    // ✅ OUI
    if (data.startsWith('pari_oui_')) {
        const parts = data.replace('pari_oui_', '').split('_');
        const fixtureId = parseInt(parts[0]);
        const suivi = matchsSuivis[fixtureId];

        // Marquer le pari comme pris
        const bet = pendingResults.find(b => b.fixtureId === fixtureId && b.prisParUtilisateur === null);
        if (bet) bet.prisParUtilisateur = true;

        bot.sendMessage(chatId,
            `✅ *Pari enregistré !*\n\n` +
            `⚽ *${suivi?.home}* marque le prochain but\n\n` +
            `Je te donnerai le résultat en fin de match. Bonne chance ! 🍀`,
            { parse_mode: "Markdown" }
        );
        saveData();
    }

    // ❌ NON
    else if (data.startsWith('pari_non_')) {
        const parts = data.replace('pari_non_', '').split('_');
        const fixtureId = parseInt(parts[0]);
        const suivi = matchsSuivis[fixtureId];

        const bet = pendingResults.find(b => b.fixtureId === fixtureId && b.prisParUtilisateur === null);
        if (bet) bet.prisParUtilisateur = false;

        bot.sendMessage(chatId,
            `❌ *Pari refusé.*\n\nJe continue à surveiller et te dirai le résultat en fin de match. 📊`,
            { parse_mode: "Markdown" }
        );
        saveData();
    }

    // ── MENU ──
    else if (data === "menu_stats") {
        const prisParMoi = results.filter(r => r.prisParUtilisateur);
        const nonPris = results.filter(r => r.prisParUtilisateur === false);
        const tauxPris = prisParMoi.length > 0 ? Math.round((prisParMoi.filter(r => r.win).length / prisParMoi.length) * 100) : "—";
        const tauxNonPris = nonPris.length > 0 ? Math.round((nonPris.filter(r => r.win).length / nonPris.length) * 100) : "—";

        bot.sendMessage(chatId,
            `📊 *STATS*\n\n` +
            `✅ Paris pris: ${prisParMoi.length} → *${tauxPris}%* de réussite\n` +
            `❌ Paris refusés: ${nonPris.length} → *${tauxNonPris}%* auraient gagné\n\n` +
            `🛡️ Mode prudent: ${modePrudent ? "ACTIF ⚠️" : "Inactif ✅"}\n` +
            `📡 Matchs surveillés: ${Object.keys(matchsSuivis).length}`,
            { parse_mode: "Markdown" }
        );
    }

    else if (data === "menu_recap") {
        bot.sendMessage(chatId, "📅 Lancement du récap...");
        sendDailyRecap();
    }

    else if (data === "menu_bilan") {
        sendNightReport();
    }

    else if (data === "menu_history") {
        const derniers = results.filter(r => r.prisParUtilisateur).slice(-10);
        if (derniers.length === 0) { bot.sendMessage(chatId, "📈 Pas encore de paris pris."); return; }
        let msg = "📈 *TES 10 DERNIERS PARIS*\n\n";
        derniers.forEach((r, i) => {
            msg += `${i + 1}. ${r.win ? "✅ WIN" : "❌ LOSE"} — *${r.home}* vs ${r.away}\n`;
            const coteAff = r.coteNextGoal ? `Cote prochain but: ${r.coteNextGoal}` : "Cote N/A";
            msg += `   ${coteAff} | Minute: ${r.minuteSignal}'\n\n`;
        });
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    else if (data === "menu_manques") {
        const manques = results.filter(r => !r.prisParUtilisateur && r.win).slice(-5);
        if (manques.length === 0) { bot.sendMessage(chatId, "✅ Aucun bon pari manqué !"); return; }
        let msg = "😬 *PARIS REFUSÉS QUI AURAIENT GAGNÉ*\n\n";
        manques.forEach((r, i) => {
            msg += `${i + 1}. ✅ *${r.home}* vs ${r.away} — minute ${r.minuteSignal}'\n`;
        });
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    else if (data === "menu_leagues") {
        const ligues = Object.entries(leagueStats).filter(([, s]) => s.total > 0);
        if (ligues.length === 0) { bot.sendMessage(chatId, "🏆 Pas encore de données."); return; }
        const sorted = ligues.sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total));
        let msg = "🏆 *STATS PAR LIGUE*\n\n";
        sorted.forEach(([league, stats]) => {
            const taux = Math.round((stats.wins / stats.total) * 100);
            msg += `${taux >= 70 ? "⭐" : taux >= 50 ? "✅" : "❌"} ${league}: ${taux}% (${stats.wins}W/${stats.total - stats.wins}L)\n`;
        });
        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    }

    else if (data === "menu_live_now") {
        bot.sendMessage(chatId, "📡 Récupération des matchs surveillés...");
        afficherMatchsSuivis();
    }

    else if (data === "menu_bankroll") {
        bot.sendMessage(chatId,
            `💰 *BANKROLL*\n\nBankroll: *${bankroll}€*\n\n/setbankroll [montant]`,
            { parse_mode: "Markdown" }
        );
    }

    else if (data === "menu_semaine") {
        sendWeeklyReport();
    }

    else if (data === "menu_reset") {
        const keyboard = { inline_keyboard: [[
            { text: "✅ Confirmer", callback_data: "confirm_reset" },
            { text: "❌ Annuler", callback_data: "menu_back" }
        ]]};
        bot.sendMessage(chatId, "⚠️ Réinitialiser les données ?", { reply_markup: keyboard });
    }

    else if (data === "confirm_reset") {
        modePrudent = false;
        saveData();
        bot.sendMessage(chatId, "✅ Réinitialisé !");
    }

    else if (data === "menu_back") {
        sendMainMenu();
    }
});

// ============================================================
// 📡 MATCHS SURVEILLÉS EN COURS
// ============================================================

async function afficherMatchsSuivis() {
    const matches = await getMatchesLive();
    const ids = Object.keys(matchsSuivis).map(Number);

    if (ids.length === 0) {
        bot.sendMessage(chatId, "📡 Aucun match surveillé pour le moment.\nLe récap de 10h enregistre automatiquement les matchs du jour.");
        return;
    }

    let msg = `📡 *MATCHS SURVEILLÉS*\n`;
    msg += `🕐 ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const id of ids) {
        const suivi = matchsSuivis[id];
        const liveMatch = matches.find(m => m.fixture.id === id);

        if (liveMatch) {
            const minute = liveMatch.fixture.status.elapsed || 0;
            const statut = liveMatch.fixture.status.short;
            const goalsHome = liveMatch.goals.home ?? 0;
            const goalsAway = liveMatch.goals.away ?? 0;
            const statutLabel = statut === "HT" ? "⏸️ MI-TEMPS" : statut === "FT" ? "✅ TERMINÉ" : `▶️ ${minute}'`;

            msg += `${statutLabel}\n`;
            msg += `⚽ *${suivi.home}* ${goalsHome} - ${goalsAway} ${suivi.away}\n`;
            msg += `📊 V1: ${suivi.v1} | N: ${suivi.vN} | V2: ${suivi.v2}\n`;
            msg += `🎯 Signal envoyé: ${suivi.signalEnvoye ? "✅ Oui" : "⏳ En attente but V2"}\n`;
        } else {
            msg += `⏳ *${suivi.home}* vs ${suivi.away} — pas encore commencé\n`;
            msg += `📊 V1: ${suivi.v1} | N: ${suivi.vN} | V2: ${suivi.v2}\n`;
        }
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    msg += `🔢 ${ids.length} match(s) surveillé(s)`;
    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

// ============================================================
// 🌙 BILAN NOCTURNE 23H
// ============================================================

async function sendNightReport() {
    const today = new Date().toLocaleDateString('fr-FR');
    const hier = Date.now() - 24 * 60 * 60 * 1000;
    const aujourdhui = results.filter(r => r.timestamp && r.timestamp > hier);
    const prisAujourdhui = aujourdhui.filter(r => r.prisParUtilisateur);
    const refusesAujourdhui = aujourdhui.filter(r => r.prisParUtilisateur === false);

    const totalPris = results.filter(r => r.prisParUtilisateur);
    const winsTotal = totalPris.filter(r => r.win).length;
    const tauxGlobal = totalPris.length > 0 ? Math.round((winsTotal / totalPris.length) * 100) : 0;

    let msg = `🌙 *BILAN DU JOUR — ${today}*\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    if (prisAujourdhui.length === 0 && refusesAujourdhui.length === 0) {
        msg += `Aucun signal aujourd'hui.\n\n`;
    } else {
        // Détail de chaque pari du jour
        msg += `📋 *Détail des signaux:*\n\n`;
        aujourdhui.forEach((r, i) => {
            const decision = r.prisParUtilisateur ? "✅ Pris" : "❌ Refusé";
            const resultat = r.win ? "🟢 Victoire" : "🔴 Perdu";
            const coteAff = r.coteNextGoal ? `Cote: ${r.coteNextGoal}` : "Cote N/A";
            msg += `${i + 1}. *${r.home}* vs ${r.away}\n`;
            msg += `   ${decision} | ${coteAff} | Min: ${r.minuteSignal}'\n`;
            msg += `   ${resultat}\n\n`;
        });

        msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `📊 *Résumé du jour:*\n`;
        msg += `🟢 Victoires: ${prisAujourdhui.filter(r => r.win).length}\n`;
        msg += `🔴 Perdus: ${prisAujourdhui.filter(r => !r.win).length}\n`;

        if (prisAujourdhui.length > 0) {
            const tauxJour = Math.round((prisAujourdhui.filter(r => r.win).length / prisAujourdhui.length) * 100);
            msg += `📈 Taux du jour: *${tauxJour}%*\n\n`;
        }
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📈 *Global:* ${winsTotal}W / ${totalPris.length - winsTotal}L → *${tauxGlobal}%*\n`;
    msg += `🛡️ Mode prudent: ${modePrudent ? "ACTIF ⚠️" : "Inactif ✅"}`;

    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

// ============================================================
// 📅 RÉCAP HEBDOMADAIRE — dimanche 20h
// ============================================================

async function sendWeeklyReport() {
    const ilYa7Jours = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const semaine = results.filter(r => r.timestamp && r.timestamp > ilYa7Jours);
    const prisSemaine = semaine.filter(r => r.prisParUtilisateur);
    const refusesSemaine = semaine.filter(r => r.prisParUtilisateur === false);

    const wins = prisSemaine.filter(r => r.win).length;
    const losses = prisSemaine.filter(r => !r.win).length;
    const taux = prisSemaine.length > 0 ? Math.round((wins / prisSemaine.length) * 100) : 0;

    // Stats par ligue cette semaine
    const liguesSemaine = {};
    semaine.forEach(r => {
        if (!liguesSemaine[r.league]) liguesSemaine[r.league] = { wins: 0, total: 0 };
        liguesSemaine[r.league].total++;
        if (r.win) liguesSemaine[r.league].wins++;
    });

    const topLigues = Object.entries(liguesSemaine)
        .filter(([, s]) => s.total >= 2)
        .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total));

    const dateDebut = new Date(ilYa7Jours).toLocaleDateString('fr-FR');
    const dateFin = new Date().toLocaleDateString('fr-FR');

    let msg = `📅 *RÉCAP HEBDOMADAIRE*\n`;
    msg += `🗓️ ${dateDebut} → ${dateFin}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (prisSemaine.length === 0) {
        msg += `Aucun pari cette semaine.\n`;
    } else {
        // Détail jour par jour
        const parJour = {};
        semaine.forEach(r => {
            const jour = new Date(r.timestamp).toLocaleDateString('fr-FR');
            if (!parJour[jour]) parJour[jour] = [];
            parJour[jour].push(r);
        });

        Object.entries(parJour).forEach(([jour, paris]) => {
            const prisJour = paris.filter(r => r.prisParUtilisateur);
            const wJour = prisJour.filter(r => r.win).length;
            const lJour = prisJour.filter(r => !r.win).length;
            msg += `📆 *${jour}*: ${wJour}🟢 / ${lJour}🔴\n`;
        });

        msg += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `📊 *TOTAL SEMAINE:*\n`;
        msg += `🟢 Victoires: ${wins}\n`;
        msg += `🔴 Perdus: ${losses}\n`;
        msg += `📈 Taux de réussite: *${taux}%*\n\n`;

        msg += `❌ Paris refusés: ${refusesSemaine.length} (${refusesSemaine.filter(r => r.win).length} auraient gagné)\n\n`;

        if (topLigues.length > 0) {
            msg += `🏆 *Ligues cette semaine:*\n`;
            topLigues.forEach(([league, stats]) => {
                const t = Math.round((stats.wins / stats.total) * 100);
                msg += `${t >= 70 ? "⭐" : t >= 50 ? "✅" : "❌"} ${league}: ${t}% (${stats.wins}W/${stats.total - stats.wins}L)\n`;
            });
        }
    }

    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    console.log("📅 Récap hebdomadaire envoyé");
}

// ============================================================
// 🎮 MENU PRINCIPAL
// ============================================================

function isAuthorized(msg) {
    return String(msg.chat.id) === String(chatId);
}

function sendMainMenu() {
    const keyboard = {
        inline_keyboard: [
            [
                { text: "📊 Stats & % réussite", callback_data: "menu_stats" },
                { text: "📅 Récap du jour", callback_data: "menu_recap" }
            ],
            [
                { text: "📡 Matchs surveillés", callback_data: "menu_live_now" }
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
                { text: "🌙 Bilan du jour", callback_data: "menu_bilan" },
                { text: "📅 Récap semaine", callback_data: "menu_semaine" }
            ],
            [
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

bot.onText(/\/setbankroll (\d+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = parseInt(match[1]);
    if (val < 10 || val > 100000) { bot.sendMessage(chatId, "❌ Valeur entre 10 et 100000"); return; }
    bankroll = val; saveData();
    bot.sendMessage(chatId, `✅ Bankroll → *${bankroll}€* | Mise: ${getMiseOptimale()}% (≈ ${(bankroll * getMiseOptimale() / 100).toFixed(2)}€)`, { parse_mode: "Markdown" });
});

bot.onText(/\/semaine/, (msg) => {
    if (!isAuthorized(msg)) return;
    sendWeeklyReport();
});

bot.onText(/\/modeprudent (.+)/, (msg, match) => {
    if (!isAuthorized(msg)) return;
    const val = match[1].toLowerCase();
    if (val === "on") { modePrudent = true; saveData(); bot.sendMessage(chatId, "🛡️ Mode prudent activé."); }
    else if (val === "off") { modePrudent = false; saveData(); bot.sendMessage(chatId, "✅ Mode prudent désactivé."); }
});

// ============================================================
// 🧠 AUTO LEARNING — toutes les 10 minutes
// ============================================================

setInterval(() => {
    const prisParMoi = results.filter(r => r.prisParUtilisateur);
    if (prisParMoi.length < 10) return;

    const wins = prisParMoi.filter(r => r.win);
    const losses = prisParMoi.filter(r => !r.win);
    if (wins.length === 0 || losses.length === 0) return;

    // Analyser à quelle minute les signaux gagnants arrivent
    const avgMinuteWin = Math.round(wins.reduce((a, b) => a + (b.minuteSignal || 0), 0) / wins.length);
    const avgMinuteLoss = Math.round(losses.reduce((a, b) => a + (b.minuteSignal || 0), 0) / losses.length);

    console.log(`🧠 AUTO LEARNING — Minute moyenne WIN: ${avgMinuteWin}' | LOSE: ${avgMinuteLoss}'`);

    // Rapport tous les 20 paris
    if (prisParMoi.length % 20 === 0) {
        const taux = Math.round((wins.length / prisParMoi.length) * 100);
        bot.sendMessage(chatId,
            `🧠 *RAPPORT AUTO-LEARNING*\n\n` +
            `📊 Basé sur ${prisParMoi.length} paris\n` +
            `✅ Taux de réussite: ${taux}%\n\n` +
            `⏱️ Minute moyenne des signaux gagnants: ${avgMinuteWin}'\n` +
            `⏱️ Minute moyenne des signaux perdants: ${avgMinuteLoss}'\n\n` +
            `💡 Les signaux à la ${avgMinuteWin}' sont les plus rentables !`,
            { parse_mode: "Markdown" }
        );
    }
}, 600000);

// ============================================================
// ⏰ SCHEDULERS
// ============================================================

setInterval(() => {
    const parisTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const h = parisTime.getHours();
    const m = parisTime.getMinutes();
    const jour = parisTime.getDay(); // 0 = dimanche

    if (h === 10 && m === 0) sendDailyRecap();
    if (h === 23 && m === 0) sendNightReport();
    if (jour === 0 && h === 20 && m === 0) sendWeeklyReport(); // dimanche 20h
}, 60000);
