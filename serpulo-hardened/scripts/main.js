// =================================================================
//  Serpulo: Закалённый v2.0  |  scripts/main.js
//  Mindustry Build 158+
//
//  Особенности:
//    1. Прогрессивная сложность — каждый сектор Serpulo тяжелее.
//    2. Волны-всплески (SURGE) — новая механика каждые N волн.
//    3. Новый сектор «Кризисная Зона» — после ЯПК.
//    4. Программная расстановка спавнов для нового сектора.
// =================================================================

// ── ТАБЛИЦА СЛОЖНОСТИ СЕКТОРОВ ────────────────────────────────────
// 0.0 = ванилла, 1.0 = максимум
var DIFFICULTY = {
    // Ранние
    "windswept-islands":         0.10,
    "the-craters":               0.18,
    "frozen-forest":             0.25,
    "tar-fields":                0.30,
    "saltflats":                 0.35,
    // Средние
    "fungal-pass":               0.42,
    "overgrowth":                0.48,
    "stained-mountains":         0.55,
    "shattered-ravine":          0.60,
    "biomassbogs":               0.65,
    // Поздние
    "ruinous-shores":            0.72,
    "impact-0078":               0.78,
    "desolate-rift":             0.84,
    // Финал
    "nuclear-complex":           0.90,
    "planetary-launch-terminal": 0.95,
    // Наш сектор
    "crisis-zone":               1.00
};

var DEFAULT_DIFF = 0.35;  // для неизвестных секторов

// ── СОСТОЯНИЕ ─────────────────────────────────────────────────────
var inSerpulo    = false;
var sectorDiff   = 0;
var sectorName   = "";
var surgeActive  = false;
var surgeBaseHP  = 1.0;
var surgeBaseDMG = 1.0;

// Каждые SURGE_EVERY волн → волна-всплеск
var SURGE_EVERY  = 5;

// ── Типы событий ──────────────────────────────────────────────────
var WorldLoadEvent = Java.type("mindustry.game.EventType$WorldLoadEvent");
var WaveEvent      = Java.type("mindustry.game.EventType$WaveEvent");

// ═════════════════════════════════════════════════════════════════
//  1. ЗАГРУЗКА МИРА — расставить правила
// ═════════════════════════════════════════════════════════════════
Events.on(WorldLoadEvent, function () {
    try {
        inSerpulo  = false;
        surgeActive = false;

        if (!Vars.state.isCampaign()) return;

        var sector = Vars.state.getSector();
        if (sector == null || sector.planet == null) return;
        if ((sector.planet.name + "") !== "serpulo") return;

        sectorName = sector.name + "";
        sectorDiff = (DIFFICULTY[sectorName] !== undefined)
            ? DIFFICULTY[sectorName]
            : DEFAULT_DIFF;
        inSerpulo  = true;

        var rules  = Vars.state.rules;
        var d      = sectorDiff;

        // ── А) Интервал волн ──────────────────────────────────────
        if (rules.waveSpacing > 0) {
            rules.waveSpacing = Math.max(
                120,
                Math.round(rules.waveSpacing * (1.0 - d * 0.50))
            );
        }

        // ── Б) Количество врагов в группах ───────────────────────
        var countMult   = 1.0 + d * 1.60;   // ×1.0 … ×2.6
        var scalingMult = 1.0 + d * 0.90;   // ×1.0 … ×1.9
        var minScale    = d * 0.60;          //   0  … 0.6

        var spawns = rules.spawns;
        if (spawns != null) {
            for (var i = 0; i < spawns.size; i++) {
                var g = spawns.get(i);
                g.amount      = Math.max(1, Math.floor(g.amount * countMult));
                g.unitScaling = Math.max(g.unitScaling * scalingMult, minScale);

                // Щит только для crisis-zone
                if (sectorName === "crisis-zone") {
                    g.shieldAmount  = (g.shieldAmount  || 0) + 150;
                    g.shieldScaling = (g.shieldScaling || 0) + 4.0;
                }
            }
        }

        // ── В) Волн до захвата ────────────────────────────────────
        if (rules.winWave > 0) {
            rules.winWave += Math.round(d * 22);
        }

        // ── Г) Буст HP и урона (только после 50% сложности) ──────
        if (d >= 0.50) {
            var t = (d - 0.50) / 0.50;          // 0..1
            rules.unitHealthMultiplier *= 1.0 + t * 1.30;   // ×1.0 … ×2.3
            rules.unitDamageMultiplier *= 1.0 + t * 1.10;   // ×1.0 … ×2.1
        }

        // ── Д) Кризисная зона — расставить спавны программно ─────
        if (sectorName === "crisis-zone") {
            _placeCrisisSpawns();
        }

        // ── Е) HUD-уведомление ────────────────────────────────────
        if (!Vars.headless) {
            var threat = Math.round(d * 100);
            var color  = threat >= 80 ? "[scarlet]" : (threat >= 50 ? "[orange]" : "[yellow]");
            var msg    = "[scarlet]⚠ Serpulo: Закалённый[] | " +
                         sectorName + " | Угроза: " + color + threat + "%";
            Core.app.post(function () {
                try { Vars.ui.announce(msg, 5); } catch (_) {}
            });
        }

        Log.info("[SH] " + sectorName + " | d=" + d.toFixed(2) +
            " | count×" + countMult.toFixed(2) +
            " | waves+" + Math.round(d * 22));

    } catch (e) {
        Log.err("[SH] WorldLoad error: " + e);
    }
});

// ═════════════════════════════════════════════════════════════════
//  2. СОБЫТИЕ ВОЛНЫ — волна-всплеск (SURGE)
// ═════════════════════════════════════════════════════════════════
Events.on(WaveEvent, function () {
    if (!inSerpulo) return;
    try {
        var rules = Vars.state.rules;
        var wave  = Vars.state.wave;

        // Сбрасываем прошлый всплеск
        if (surgeActive) {
            rules.unitHealthMultiplier = surgeBaseHP;
            rules.unitDamageMultiplier = surgeBaseDMG;
            surgeActive = false;
        }

        // Интервал всплеска уменьшается с ростом сложности
        // diff=0→каждые 5, diff=1→каждые 3
        var interval = Math.max(3, SURGE_EVERY - Math.floor(sectorDiff * 2));

        if (wave > 0 && wave % interval === 0) {
            surgeBaseHP  = rules.unitHealthMultiplier;
            surgeBaseDMG = rules.unitDamageMultiplier;

            var hpMult  = 1.50 + sectorDiff * 1.00;   // ×1.5 … ×2.5
            var dmgMult = 1.30 + sectorDiff * 0.80;   // ×1.3 … ×2.1

            rules.unitHealthMultiplier = surgeBaseHP  * hpMult;
            rules.unitDamageMultiplier = surgeBaseDMG * dmgMult;
            surgeActive = true;

            if (!Vars.headless) {
                var waveNum = wave + "";
                var h = hpMult.toFixed(1);
                var dm = dmgMult.toFixed(1);
                Core.app.post(function () {
                    try {
                        Vars.ui.announce(
                            "[scarlet]⚡ ВОЛНА-ВСПЛЕСК #" + waveNum + "![] " +
                            "HP [red]×" + h + "[]  Урон [orange]×" + dm + "[]",
                            6
                        );
                    } catch (_) {}
                });
            }

            Log.info("[SH] SURGE wave " + wave +
                " hp×" + hpMult.toFixed(2) + " dmg×" + dmgMult.toFixed(2));
        }

    } catch (e) {
        Log.err("[SH] WaveEvent error: " + e);
    }
});

// ═════════════════════════════════════════════════════════════════
//  3. РАССТАНОВКА СПАВНОВ ДЛЯ КРИЗИСНОЙ ЗОНЫ
// ═════════════════════════════════════════════════════════════════
function _placeCrisisSpawns() {
    Core.app.post(function () {
        try {
            var spawnBlock = Vars.content.block("spawn");
            if (spawnBlock == null) {
                Log.warn("[SH] Блок 'spawn' не найден, волны могут не работать.");
                return;
            }

            var Team = Java.type("mindustry.game.Team");
            var crux = Team.crux;
            var w    = Vars.world.width();
            var h    = Vars.world.height();

            // 8 точек спавна по периметру
            var pts = [
                [3,       3      ],   // СЗ
                [w - 4,   3      ],   // СВ
                [3,       h - 4  ],   // ЮЗ
                [w - 4,   h - 4  ],   // ЮВ
                [(w/2)|0, 3      ],   // Север
                [(w/2)|0, h - 4  ],   // Юг
                [3,       (h/2)|0],   // Запад
                [w - 4,   (h/2)|0]    // Восток
            ];

            var placed = 0;
            for (var i = 0; i < pts.length; i++) {
                var tile = Vars.world.tile(pts[i][0], pts[i][1]);
                if (tile != null) {
                    tile.setNet(spawnBlock, crux, 0);
                    placed++;
                }
            }

            Log.info("[SH] Кризисная Зона: расставлено спавнов: " + placed);

        } catch (e) {
            Log.err("[SH] Ошибка расстановки спавнов: " + e);
        }
    });
}

// ─────────────────────────────────────────────────────────────────
Log.info("[Serpulo:Hardened v2.0] Загружен. Прогресс + Surge + Кризисная Зона.");
