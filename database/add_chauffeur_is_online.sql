-- Ajout de la colonne is_online pour séparer le toggle en ligne/hors ligne
-- du statut d'activation du compte (status ENUM('active','disabled')).
--
-- Avant : status était utilisé pour les deux → conflit.
-- Après : status = activation admin, is_online = toggle chauffeur.

ALTER TABLE chauffeur
  ADD COLUMN IF NOT EXISTS is_online TINYINT(1) NOT NULL DEFAULT 0
  AFTER status;
