-- ================================================================
-- Migration lot F1 — à exécuter UNE FOIS dans phpMyAdmin (onglet SQL),
-- sur la base de production. Sans danger si relancée (IF NOT EXISTS).
--
-- Contexte : l'espace admin lit rides.client_problem_resolved_at
-- (list_problems.php, list_rides.php, resolve_client_problem.php) mais
-- cette colonne n'était pas dans schema.sql. En production elle existe
-- sans doute déjà (sinon l'admin serait en erreur) : cette commande ne
-- fait alors rien. Elle protège une installation neuve (Docker, nouvel
-- hébergement).
-- ================================================================

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS client_problem_resolved_at TIMESTAMP NULL DEFAULT NULL AFTER client_problem_at;

-- Vérification : doit renvoyer une ligne.
SHOW COLUMNS FROM rides LIKE 'client_problem_resolved_at';
