-- Ajout de cancelled_client dans l'ENUM status de la table rides
-- Nécessaire pour distinguer les annulations client des annulations chauffeur.

ALTER TABLE rides
  MODIFY COLUMN status ENUM('pending','accepted','arrived','started','completed','cancelled','cancelled_client','reported') NOT NULL DEFAULT 'pending';
