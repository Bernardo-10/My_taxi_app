-- LOT 7 — index OPTIONNEL (accélère l'historique quand il y a beaucoup de courses).
-- Sans danger : n'ajoute que des index, ne modifie aucune donnée.
-- À exécuter dans phpMyAdmin (onglet SQL), base if0_42292648_taxi_app.
-- "IF NOT EXISTS" : on peut le relancer sans erreur (MariaDB).

CREATE INDEX IF NOT EXISTS idx_rides_driver_status_completed
    ON rides (driver_id, status, completed_at);

CREATE INDEX IF NOT EXISTS idx_wallet_ride
    ON wallet_transactions (ride_id);
