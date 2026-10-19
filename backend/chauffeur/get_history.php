<?php
/**
 * get_history.php — Lot 7 : historique et gains du chauffeur.
 *
 * Remplace l'envoi de TOUTES les courses terminées par get_rides.php (qui
 * grossissait à chaque course et partait à chaque poll). Ici :
 *   - les TOTAUX sont calculés par la base (exacts, quel que soit le nombre de courses) ;
 *   - la liste des courses est paginée (20 par page) ;
 *   - la commission de chaque course est celle RÉELLEMENT débitée
 *     (wallet_transactions, type 'commission'), avec repli sur le taux actuel
 *     pour une course qui n'aurait pas de ligne (courses anciennes).
 *
 * Paramètres GET (tous facultatifs) :
 *   from, to : période AAAA-MM-JJ (comparée à la date de fin de course)
 *   page     : numéro de page, 1 par défaut (20 courses par page)
 *   all=1    : export CSV — toutes les courses de la période (plafond 5000), sans pagination
 */
require_once __DIR__ . "/../config/auth.php";

error_reporting(E_ALL);
ini_set("display_errors", 0);

$driverId = require_driver_id();

const HISTORY_PAGE_SIZE = 20;
const HISTORY_EXPORT_MAX = 5000;

/** Valide une date AAAA-MM-JJ ; renvoie la chaîne, ou null si absente/invalide. */
function history_date_param($name) {
    $v = $_GET[$name] ?? "";
    if (!is_string($v) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m)) return null;
    return checkdate((int) $m[2], (int) $m[3], (int) $m[1]) ? $v : null;
}

$from   = history_date_param("from");
$to     = history_date_param("to");
$export = ($_GET["all"] ?? "") === "1";
$page   = max(1, min(10000, (int) ($_GET["page"] ?? 1)));

$conn = db_connect();

// Date retenue pour une course terminée : même ordre de repli que le front
// (completed_at, sinon updated_at, sinon created_at).
$dateExpr = "COALESCE(r.completed_at, r.updated_at, r.created_at)";

// Commission réelle par course (somme des lignes 'commission' du portefeuille,
// stockées en négatif), pour CE chauffeur uniquement.
$commissionJoin = "
    LEFT JOIN (
        SELECT ride_id, SUM(-amount_fcfa) AS commission
        FROM wallet_transactions
        WHERE chauffeur_id = ? AND type = 'commission' AND status = 'completed' AND ride_id IS NOT NULL
        GROUP BY ride_id
    ) wt ON wt.ride_id = r.id
";
// Repli : taux actuel si la course n'a pas de ligne de commission.
$commissionExpr = "COALESCE(wt.commission, ROUND(r.price_fcfa * ?))";

// ── Filtre commun (types et valeurs liés dans le même ordre que les "?") ──
$where  = "r.driver_id = ? AND r.status = 'completed'";
$wTypes = "i";
$wVals  = [$driverId];
if ($from !== null) { $where .= " AND DATE($dateExpr) >= ?"; $wTypes .= "s"; $wVals[] = $from; }
if ($to   !== null) { $where .= " AND DATE($dateExpr) <= ?"; $wTypes .= "s"; $wVals[] = $to; }

$rate = (float) COMMISSION_RATE;

/** Prépare, lie et exécute une requête ; renvoie le résultat ou null. */
function history_run($conn, $sql, $types, $vals) {
    $stmt = $conn->prepare($sql);
    if (!$stmt) return null;
    $stmt->bind_param($types, ...$vals);
    if (!$stmt->execute()) { $stmt->close(); return null; }
    $res = $stmt->get_result();
    $stmt->close();
    return $res;
}

// ── 1. Totaux ────────────────────────────────────────────────────
// Ordre des "?" : sous-requête (chauffeur_id), expression commission (taux), WHERE.
$totalsSql = "
    SELECT COUNT(*) AS cnt,
           COALESCE(SUM(r.price_fcfa), 0) AS revenue,
           COALESCE(SUM($commissionExpr), 0) AS commission,
           COALESCE(SUM(r.distance_km), 0) AS dist
    FROM rides r
    $commissionJoin
    WHERE $where
";
// L'expression commission est dans le SELECT, AVANT la jointure dans le texte SQL :
// l'ordre des paramètres suit l'ordre du texte -> taux, chauffeur (jointure), puis WHERE.
$totalsRes = history_run($conn, $totalsSql, "di" . $wTypes, array_merge([$rate, $driverId], $wVals));
if (!$totalsRes) {
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur lecture historique"], 500);
}
$t = $totalsRes->fetch_assoc();
$count      = (int) $t["cnt"];
$revenue    = (int) $t["revenue"];
$commission = (int) $t["commission"];

// ── 2. Courses (une page, ou tout pour l'export) ─────────────────
$limit  = $export ? HISTORY_EXPORT_MAX : HISTORY_PAGE_SIZE + 1;   // +1 : savoir s'il reste une page
$offset = $export ? 0 : ($page - 1) * HISTORY_PAGE_SIZE;

$listSql = "
    SELECT r.id, r.pickup, r.destination, r.distance_km, r.passengers, r.price_fcfa,
           r.status, $dateExpr AS completed_at,
           $commissionExpr AS commission_fcfa
    FROM rides r
    $commissionJoin
    WHERE $where
    ORDER BY $dateExpr DESC, r.id DESC
    LIMIT $limit OFFSET $offset
";
$listRes = history_run($conn, $listSql, "di" . $wTypes, array_merge([$rate, $driverId], $wVals));
if (!$listRes) {
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur lecture historique"], 500);
}

$rides = [];
while ($row = $listRes->fetch_assoc()) {
    $price = (int) $row["price_fcfa"];
    $comm  = (int) $row["commission_fcfa"];
    $row["price_fcfa"]      = $price;
    $row["commission_fcfa"] = $comm;
    $row["net_fcfa"]        = $price - $comm;
    $rides[] = $row;
}
$conn->close();

$hasMore = false;
if (!$export && count($rides) > HISTORY_PAGE_SIZE) {
    $hasMore = true;
    array_pop($rides);
}

json_response([
    "status" => "success",
    "totals" => [
        "count"          => $count,
        "revenue_fcfa"   => $revenue,
        "commission_fcfa"=> $commission,
        "net_fcfa"       => $revenue - $commission,
        "distance_km"    => round((float) $t["dist"], 1),
    ],
    "rides"    => $rides,
    "page"     => $export ? 1 : $page,
    "has_more" => $hasMore,
    "truncated"=> $export && count($rides) >= HISTORY_EXPORT_MAX,
]);
?>
