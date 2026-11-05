-- LOT 8 — index OPTIONNEL (accélère le contrôle "référence déjà utilisée" des recharges).
-- Sans danger : n'ajoute qu'un index, ne modifie aucune donnée.
-- À exécuter dans phpMyAdmin (onglet SQL), base if0_42292648_taxi_app.
-- "IF NOT EXISTS" : on peut le relancer sans erreur (MariaDB).

CREATE INDEX IF NOT EXISTS idx_wallet_recharge_ref
    ON wallet_transactions (type, operator, reference);

-- (Lecture seule, facultatif) Références déjà présentes en double AVANT le lot 8 :
-- à regarder avec l'équipe, car ce sont peut-être des recharges créditées deux fois.
SELECT operator, UPPER(REPLACE(reference, ' ', '')) AS ref, COUNT(*) AS nb, GROUP_CONCAT(id) AS ids
FROM wallet_transactions
WHERE type = 'recharge' AND status IN ('pending', 'completed') AND reference IS NOT NULL AND reference <> ''
GROUP BY operator, UPPER(REPLACE(reference, ' ', ''))
HAVING COUNT(*) > 1;
