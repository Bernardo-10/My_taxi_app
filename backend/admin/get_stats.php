<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$conn = db_connect();
sync_stale_drivers_offline($conn);

// Totaux globaux
$stats = [];

$r = $conn->query("SELECT COUNT(*) AS total, SUM(status='active') AS actifs FROM client");
$row = $r->fetch_assoc();
$stats["clients_total"]  = (int)$row["total"];
$stats["clients_actifs"] = (int)$row["actifs"];

$r = $conn->query("SELECT COUNT(*) AS total, SUM(status = 'active') AS actifs, SUM(is_online = 1) AS en_ligne FROM chauffeur");
$row = $r->fetch_assoc();
$stats["chauffeurs_total"]    = (int)$row["total"];
// chauffeurs_actifs = comptes non désactivés (même sens que clients_actifs juste au-dessus).
// chauffeurs_en_ligne = réellement en ligne à l'instant présent -- fiable car
// sync_stale_drivers_offline() vient de corriger les faux positifs ci-dessus.
$stats["chauffeurs_actifs"]   = (int)$row["actifs"];
$stats["chauffeurs_en_ligne"] = (int)$row["en_ligne"];

$r = $conn->query("SELECT COUNT(*) AS total FROM rides");
$stats["courses_total"] = (int)$r->fetch_assoc()["total"];

$r = $conn->query("SELECT COUNT(*) AS total FROM rides WHERE status='pending'");
$stats["courses_pending"] = (int)$r->fetch_assoc()["total"];

$r = $conn->query("SELECT COUNT(*) AS total FROM rides WHERE status IN ('accepted','arrived','started')");
$stats["courses_en_cours"] = (int)$r->fetch_assoc()["total"];

$r = $conn->query("SELECT COUNT(*) AS total FROM rides WHERE status='completed'");
$stats["courses_completees"] = (int)$r->fetch_assoc()["total"];

$r = $conn->query("SELECT COUNT(*) AS total FROM rides WHERE status='cancelled'");
$stats["courses_annulees"] = (int)$r->fetch_assoc()["total"];

$r = $conn->query("SELECT COUNT(*) AS total FROM rides WHERE status='cancelled_client'");
$stats["courses_annulees_clients"] = (int)$r->fetch_assoc()["total"];

// Annulées total = chauffeur + client
$stats["courses_annulees"] += $stats["courses_annulees_clients"];

$r = $conn->query("SELECT IFNULL(SUM(price_fcfa),0) AS total FROM rides WHERE status='completed'");
$stats["chiffre_affaires_fcfa"] = (int)$r->fetch_assoc()["total"];

// Taux de complétion
$stats["taux_completion"] = $stats["courses_total"] > 0
    ? round($stats["courses_completees"] / $stats["courses_total"] * 100, 1)
    : 0;

// Courses des 7 derniers jours (par jour)
$r = $conn->query("
    SELECT DATE(created_at) AS jour, COUNT(*) AS nb, IFNULL(SUM(price_fcfa),0) AS ca
    FROM rides
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY DATE(created_at)
    ORDER BY jour ASC
");
$stats["courbes_7j"] = [];
while ($row = $r->fetch_assoc()) {
    $stats["courbes_7j"][] = ["jour" => $row["jour"], "nb" => (int)$row["nb"], "ca" => (int)$row["ca"]];
}

$conn->close();
json_response(["status" => "success", "stats" => $stats]);
?>
