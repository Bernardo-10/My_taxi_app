<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$conn = db_connect();

// Vue d'ensemble des portefeuilles chauffeurs : solde actuel + totaux dérivés
// des transactions + dernière activité. Lecture seule (pas d'action de
// validation ici -- voir décision produit : les approbations de recharge
// passeront par le mode de paiement, pas par l'admin).
$sql = "
    SELECT
        c.id, c.name, c.phone, c.wallet_balance_fcfa,
        (SELECT IFNULL(SUM(ABS(amount_fcfa)), 0) FROM wallet_transactions wt
            WHERE wt.chauffeur_id = c.id AND wt.type = 'commission' AND wt.status = 'completed'
        ) AS total_commissions_fcfa,
        (SELECT IFNULL(SUM(amount_fcfa), 0) FROM wallet_transactions wt
            WHERE wt.chauffeur_id = c.id AND wt.type = 'recharge' AND wt.status = 'completed'
        ) AS total_recharges_fcfa,
        (SELECT COUNT(*) FROM wallet_transactions wt
            WHERE wt.chauffeur_id = c.id AND wt.type = 'recharge' AND wt.status = 'pending'
        ) AS recharges_en_attente,
        (SELECT wt.created_at FROM wallet_transactions wt
            WHERE wt.chauffeur_id = c.id ORDER BY wt.created_at DESC LIMIT 1
        ) AS derniere_transaction_at,
        (SELECT wt.type FROM wallet_transactions wt
            WHERE wt.chauffeur_id = c.id ORDER BY wt.created_at DESC LIMIT 1
        ) AS derniere_transaction_type
    FROM chauffeur c
    ORDER BY (recharges_en_attente > 0) DESC, wallet_balance_fcfa ASC
";
// Tri : priorité aux chauffeurs avec une recharge en attente (action requise
// de l'admin), puis par solde croissant à l'intérieur de chaque groupe --
// les plus endettés (négatif) remontent en premier, c'est l'info la plus
// utile à surveiller pour l'admin au quotidien.

$result = $conn->query($sql);

$wallets = [];
while ($row = $result->fetch_assoc()) {
    $row["id"]                       = (int)$row["id"];
    $row["wallet_balance_fcfa"]      = (int)$row["wallet_balance_fcfa"];
    $row["total_commissions_fcfa"]   = (int)$row["total_commissions_fcfa"];
    $row["total_recharges_fcfa"]     = (int)$row["total_recharges_fcfa"];
    $row["recharges_en_attente"]     = (int)$row["recharges_en_attente"];
    $wallets[] = $row;
}

$conn->close();
json_response(["status" => "success", "wallets" => $wallets]);
?>
