-- ================================================================
--  Lot F4 — signalement chauffeur NON terminal
--  À exécuter dans phpMyAdmin (onglet SQL) AVANT de déposer les fichiers PHP.
--  Sans danger si rejoué (IF NOT EXISTS).
--
--  La colonne rides.problem_description existe déjà (texte du chauffeur).
--  On ajoute seulement la date du signalement et la date de traitement,
--  sur le modèle de client_problem_at / client_problem_resolved_at.
-- ================================================================
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS problem_at          TIMESTAMP NULL DEFAULT NULL AFTER problem_description,
  ADD COLUMN IF NOT EXISTS problem_resolved_at TIMESTAMP NULL DEFAULT NULL AFTER problem_at;

-- Anciens signalements chauffeur (course restée au statut 'reported') :
-- on leur donne une date (dernière modification de la course). Ils
-- apparaîtront UNE fois dans les alertes admin comme « à traiter » ;
-- l'admin les marque traités. Pour les considérer déjà traités d'office,
-- décommentez la 2e ligne.
UPDATE rides SET problem_at = updated_at WHERE problem_description IS NOT NULL AND problem_at IS NULL;
-- UPDATE rides SET problem_resolved_at = updated_at WHERE problem_description IS NOT NULL AND problem_resolved_at IS NULL;
