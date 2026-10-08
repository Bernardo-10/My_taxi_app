/**
 * route-planner.js — TaxiGo Interface Chauffeur
 *
 * Planificateur d'itinéraire UNIQUE : à partir de la position du chauffeur et
 * de toutes ses courses actives, calcule le meilleur ordre de passage (distance
 * totale la plus courte) puis UNE seule ligne qui visite tous les arrêts.
 *
 * Ce module est volontairement indépendant de Leaflet et du DOM : il ne manipule
 * que des coordonnées, des identifiants de courses et des promesses. Il pourra
 * être repris tel quel (en TypeScript) dans la phase React.
 *
 * Arrêts (stops) :
 *   - course accepted / arrived : un arrêt "pickup" (À récupérer) + un arrêt "drop"
 *   - course started            : un arrêt "drop" seulement (client déjà à bord)
 *
 * Contraintes prises en compte :
 *   - le pickup d'une course précède toujours son propre drop ;
 *   - une course "arrived" (client présent devant le chauffeur) est servie en premier ;
 *   - la capacité du véhicule (passagers à bord) n'est jamais dépassée ;
 *   - critère : distance totale (itinéraire ouvert), avec un très léger poids sur
 *     l'attente des clients à récupérer pour départager des ordres quasi équivalents.
 *
 * Réseau : 2 requêtes OSRM par calcul, quel que soit le nombre de courses
 *   1) /table  -> matrice des distances (chauffeur + arrêts)
 *   2) /route  -> géométrie complète + distance/durée de chaque tronçon
 * Si OSRM est injoignable : mode dégradé (distances à vol d'oiseau x 1.3, lignes
 * droites), signalé par plan.approx = true.
 */
(function (global) {
    "use strict";

    // URL du routeur : surchargeable avant le chargement de ce script avec
    // window.TAXIGO_OSRM_BASE = "https://mon-osrm.example.com"
    const OSRM_BASE        = String(global.TAXIGO_OSRM_BASE || "https://router.project-osrm.org").replace(/\/+$/, "");
    const FETCH_TIMEOUT_MS = 8000;

    // Au-delà, énumération exacte trop coûteuse (5 courses = 10 arrêts = 113 400
    // ordres valides au maximum) : on bascule sur un parcours glouton.
    const MAX_EXACT_STOPS  = 10;

    // Poids de l'attente des clients dans le coût (distance cumulée à chaque pickup).
    // 0.02 = simple départage : la distance totale reste le critère dominant.
    const WAIT_WEIGHT      = 0.02;

    // Facteur de détour appliqué aux distances à vol d'oiseau (mode dégradé).
    const DETOUR_FACTOR    = 1.3;
    const FALLBACK_SPEED_MS = 25 / 3.6;   // 25 km/h en m/s (mode dégradé)

    /* ───────────── Utilitaires géographiques ───────────── */

    function toNum(v) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : NaN;
    }

    function haversineM(lat1, lng1, lat2, lng2) {
        const R    = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a    = Math.sin(dLat / 2) ** 2 +
                     Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                     Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function coordKey(lat, lng) {
        return lat.toFixed(5) + "," + lng.toFixed(5);
    }

    /* ───────────── Arrêts ───────────── */

    /**
     * Construit la liste des arrêts à partir des courses (statuts déjà "effectifs").
     * Les courses pending, completed, cancelled* sont ignorées.
     */
    function buildStops(rides) {
        const stops = [];
        for (const r of (rides || [])) {
            if (!r || (r.status !== "accepted" && r.status !== "arrived" && r.status !== "started")) continue;

            const pLat = toNum(r.pickup_lat),       pLng = toNum(r.pickup_lng);
            const dLat = toNum(r.destination_lat),  dLng = toNum(r.destination_lng);
            const pax  = Math.max(1, parseInt(r.passengers, 10) || 1);

            const pickupValid = r.status !== "started" && !isNaN(pLat) && !isNaN(pLng);
            const dropValid   = !isNaN(dLat) && !isNaN(dLng);

            if (pickupValid) {
                stops.push({
                    key: r.id + ":p", rideId: r.id, type: "pickup",
                    lat: pLat, lng: pLng, coordKey: coordKey(pLat, pLng),
                    pax, address: r.pickup || "", clientName: r.client_name || "",
                    needs: null, forceFirst: r.status === "arrived"
                });
            }
            if (dropValid) {
                stops.push({
                    key: r.id + ":d", rideId: r.id, type: "drop",
                    lat: dLat, lng: dLng, coordKey: coordKey(dLat, dLng),
                    pax, address: r.destination || "", clientName: r.client_name || "",
                    needs: pickupValid ? r.id + ":p" : null,   // null = déjà à bord
                    forceFirst: false
                });
            }
        }
        return stops;
    }

    /** Signature stable de l'ensemble d'arrêts : change dès qu'un arrêt apparaît/disparaît/devient prioritaire. */
    function signature(stops) {
        return stops.map(s => s.key + (s.forceFirst ? "!" : "")).sort().join("|");
    }

    /* ───────────── Choix de l'ordre ───────────── */

    function prepare(stops) {
        const idxByKey = new Map(stops.map((s, i) => [s.key, i]));
        const needsIdx = stops.map(s => {
            if (!s.needs) return -1;
            const i = idxByKey.get(s.needs);
            return i === undefined ? -1 : i;
        });
        const forced = stops.map(s => !!s.forceFirst);
        let initialLoad = 0;
        stops.forEach(s => { if (s.type === "drop" && !s.needs) initialLoad += s.pax; });
        return { needsIdx, forced, initialLoad, forcedTotal: forced.filter(Boolean).length };
    }

    /**
     * Énumération exacte avec élagage (branch & bound).
     * M : matrice en mètres, indice 0 = chauffeur, indice i+1 = stops[i].
     * Retourne un tableau d'indices de stops, ou null si aucun ordre n'est faisable.
     */
    function chooseOrder(stops, M, capacity, enforceCapacity) {
        const n = stops.length;
        const { needsIdx, forced, initialLoad, forcedTotal } = prepare(stops);
        const full = (1 << n) - 1;

        let best = { cost: Infinity, order: null };
        const path = [];

        function dfs(cur, mask, load, dist, wait, forcedLeft) {
            if (mask === full) {
                const cost = dist + WAIT_WEIGHT * wait;
                if (cost < best.cost) best = { cost, order: path.slice() };
                return;
            }
            if (dist + WAIT_WEIGHT * wait >= best.cost) return;

            const cands = [];
            for (let j = 0; j < n; j++) {
                if (mask & (1 << j)) continue;
                if (needsIdx[j] >= 0 && !(mask & (1 << needsIdx[j]))) continue;   // pickup d'abord
                if (forcedLeft > 0 && !forced[j]) continue;                        // client présent d'abord
                if (enforceCapacity && stops[j].type === "pickup" && load + stops[j].pax > capacity) continue;
                cands.push(j);
            }
            cands.sort((a, b) => M[cur][a + 1] - M[cur][b + 1]);

            for (const j of cands) {
                const s = stops[j];
                const d = M[cur][j + 1];
                path.push(j);
                dfs(
                    j + 1,
                    mask | (1 << j),
                    s.type === "pickup" ? load + s.pax : load - s.pax,
                    dist + d,
                    wait + (s.type === "pickup" ? dist + d : 0),
                    forcedLeft - (forced[j] ? 1 : 0)
                );
                path.pop();
            }
        }

        dfs(0, 0, initialLoad, 0, 0, forcedTotal);
        return best.order;
    }

    /** Parcours glouton (plus proche arrêt faisable) — uniquement pour les très grands nombres d'arrêts. */
    function greedyOrder(stops, M, capacity) {
        const n = stops.length;
        const { needsIdx, forced, initialLoad, forcedTotal } = prepare(stops);
        const visited = new Array(n).fill(false);
        const order = [];
        let cur = 0, load = initialLoad, forcedLeft = forcedTotal;

        for (let step = 0; step < n; step++) {
            const pick = (enforceCapacity) => {
                let bestJ = -1, bestD = Infinity;
                for (let j = 0; j < n; j++) {
                    if (visited[j]) continue;
                    if (needsIdx[j] >= 0 && !visited[needsIdx[j]]) continue;
                    if (forcedLeft > 0 && !forced[j]) continue;
                    if (enforceCapacity && stops[j].type === "pickup" && load + stops[j].pax > capacity) continue;
                    if (M[cur][j + 1] < bestD) { bestD = M[cur][j + 1]; bestJ = j; }
                }
                return bestJ;
            };
            let j = pick(true);
            if (j < 0) j = pick(false);
            if (j < 0) break;
            visited[j] = true;
            order.push(j);
            load += stops[j].type === "pickup" ? stops[j].pax : -stops[j].pax;
            if (forced[j]) forcedLeft--;
            cur = j + 1;
        }
        return order;
    }

    /* ───────────── Réseau (OSRM) ───────────── */

    async function fetchJson(url, signal) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        const relay = () => ctrl.abort();
        if (signal) {
            if (signal.aborted) ctrl.abort();
            else signal.addEventListener("abort", relay, { once: true });
        }
        try {
            const res = await fetch(url, { signal: ctrl.signal });
            if (!res.ok) throw new Error("HTTP " + res.status);
            return await res.json();
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", relay);
        }
    }

    function haversineMatrix(points) {
        return points.map(a => points.map(b =>
            haversineM(a.lat, a.lng, b.lat, b.lng) * DETOUR_FACTOR
        ));
    }

    async function fetchMatrix(points, signal) {
        const coords = points.map(p => p.lng + "," + p.lat).join(";");
        const data   = await fetchJson(`${OSRM_BASE}/table/v1/driving/${coords}?annotations=distance`, signal);
        if (data.code !== "Ok" || !Array.isArray(data.distances)) throw new Error("OSRM table invalide");

        // Cases null (point non routable) : remplacées par une estimation à vol d'oiseau
        return data.distances.map((row, i) => row.map((d, j) =>
            (typeof d === "number" && Number.isFinite(d))
                ? d
                : haversineM(points[i].lat, points[i].lng, points[j].lat, points[j].lng) * DETOUR_FACTOR
        ));
    }

    async function fetchRoute(points, signal) {
        const coords = points.map(p => p.lng + "," + p.lat).join(";");
        const data   = await fetchJson(
            `${OSRM_BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`, signal
        );
        const route = data.routes && data.routes[0];
        if (data.code !== "Ok" || !route || !route.geometry || !Array.isArray(route.geometry.coordinates)
            || route.geometry.coordinates.length < 2) {
            throw new Error("OSRM route invalide");
        }
        return {
            coords : route.geometry.coordinates,
            legs   : (route.legs || []).map(l => ({ distance: l.distance, duration: l.duration })),
            totalDistance: route.distance,
            totalDuration: route.duration
        };
    }

    function straightRoute(points) {
        const legs = [];
        for (let i = 1; i < points.length; i++) {
            const d = haversineM(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng) * DETOUR_FACTOR;
            legs.push({ distance: d, duration: d / FALLBACK_SPEED_MS });
        }
        return {
            coords : points.map(p => [p.lng, p.lat]),
            legs,
            totalDistance: legs.reduce((s, l) => s + l.distance, 0),
            totalDuration: legs.reduce((s, l) => s + l.duration, 0)
        };
    }

    /* ───────────── Géométrie de la ligne ───────────── */

    function buildCum(coords) {
        const cum = [0];
        for (let i = 1; i < coords.length; i++) {
            cum.push(cum[i - 1] + haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
        }
        return cum;
    }

    function scan(coords, cum, lat, lng, from, to) {
        const kx = 111320 * Math.cos(lat * Math.PI / 180);
        const ky = 110574;
        let best = { dist: Infinity, seg: from, t: 0, lat, lng, arc: 0 };
        for (let i = from; i <= to; i++) {
            const ax = (coords[i][0]     - lng) * kx, ay = (coords[i][1]     - lat) * ky;
            const bx = (coords[i + 1][0] - lng) * kx, by = (coords[i + 1][1] - lat) * ky;
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            const px = ax + t * dx, py = ay + t * dy;
            const d  = Math.hypot(px, py);
            if (d < best.dist) {
                best = {
                    dist: d, seg: i, t,
                    lat: lat + py / ky, lng: lng + px / kx,
                    arc: cum[i] + t * (cum[i + 1] - cum[i])
                };
            }
        }
        return best;
    }

    /**
     * Projette un point sur la ligne : distance à la ligne (m), segment le plus proche,
     * point projeté et abscisse curviligne (arc, en m depuis le début de la ligne).
     * Recherche d'abord dans une fenêtre devant startSeg (progression normale du
     * chauffeur, peu coûteux), puis sur toute la ligne si le point semble éloigné.
     */
    function project(coords, cum, lat, lng, startSeg, quickAcceptM) {
        const n = coords.length;
        if (n < 2) {
            return { dist: haversineM(lat, lng, coords[0][1], coords[0][0]), seg: 0, t: 0, lat: coords[0][1], lng: coords[0][0], arc: 0 };
        }
        const from = Math.min(Math.max(0, startSeg || 0), n - 2);
        const win  = scan(coords, cum, lat, lng, from, Math.min(n - 2, from + 400));
        if (win.dist <= (quickAcceptM == null ? 40 : quickAcceptM)) return win;
        const all  = scan(coords, cum, lat, lng, 0, n - 2);
        return all.dist < win.dist ? all : win;
    }

    /* ───────────── Calcul complet ───────────── */

    /**
     * @param {{lat:number,lng:number}} driver
     * @param {Array} stops  arrêts issus de buildStops()
     * @param {{capacity?:number, signal?:AbortSignal}} opts
     * @returns {Promise<null|{order:string[], coords:number[][], latlngs:number[][], cum:number[],
     *           stopArcs:number[], legs:Array, totalDistance:number, totalDuration:number,
     *           approx:boolean, capacityRelaxed:boolean}>}
     * Rejette uniquement avec une AbortError (annulation demandée par l'appelant).
     */
    async function computePlan(driver, stops, opts) {
        opts = opts || {};
        const capacity = opts.capacity || 5;
        const signal   = opts.signal;
        if (!stops || !stops.length) return null;

        const points = [{ lat: driver.lat, lng: driver.lng }].concat(stops);
        let approx   = false;

        let M;
        try {
            M = await fetchMatrix(points, signal);
        } catch (e) {
            if (signal && signal.aborted) throw e;
            approx = true;
            M = haversineMatrix(points);
        }

        let orderIdx;
        let capacityRelaxed = false;
        if (stops.length <= MAX_EXACT_STOPS) {
            orderIdx = chooseOrder(stops, M, capacity, true);
            if (!orderIdx) {                       // capacité impossible à respecter : on n'y renonce pas à l'affichage
                orderIdx = chooseOrder(stops, M, capacity, false);
                capacityRelaxed = true;
            }
        } else {
            orderIdx = greedyOrder(stops, M, capacity);
        }
        if (!orderIdx || orderIdx.length !== stops.length) {
            orderIdx = stops.map((_, i) => i);     // dernier filet : ordre d'origine
        }

        const ordered   = orderIdx.map(i => stops[i]);
        const waypoints = [{ lat: driver.lat, lng: driver.lng }].concat(ordered);

        let route;
        try {
            route = await fetchRoute(waypoints, signal);
        } catch (e) {
            if (signal && signal.aborted) throw e;
            approx = true;
            route  = straightRoute(waypoints);
        }

        const cum = buildCum(route.coords);

        // Abscisse curviligne de chaque arrêt, dans l'ordre de passage (progression monotone)
        const stopArcs = [];
        let prevSeg = 0, prevArc = 0;
        for (const s of ordered) {
            const p = project(route.coords, cum, s.lat, s.lng, prevSeg, 15);
            prevSeg = p.seg;
            prevArc = Math.max(prevArc, p.arc);
            stopArcs.push(prevArc);
        }

        return {
            order          : ordered.map(s => s.key),
            coords         : route.coords,
            latlngs        : route.coords.map(c => [c[1], c[0]]),
            cum,
            stopArcs,
            legs           : route.legs,
            totalDistance  : route.totalDistance,
            totalDuration  : route.totalDuration,
            approx,
            capacityRelaxed
        };
    }

    global.RoutePlanner = {
        buildStops, signature, computePlan, project, haversineM, coordKey,
        // exposés pour les tests
        _chooseOrder: chooseOrder, _greedyOrder: greedyOrder
    };
})(typeof window !== "undefined" ? window : globalThis);
