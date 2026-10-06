-- ================================================================
-- Migration lot F3b — nouveau statut de course : 'expired'
-- À exécuter dans phpMyAdmin (onglet SQL) AVANT de mettre en ligne les
-- fichiers PHP du lot. Les deux étapes se lancent séparément.
--
-- Pourquoi avant : backend/common/ride_expiry.php passe en 'expired' les
-- courses 'pending' de plus de 30 minutes. Il vérifie d'abord que le statut
-- existe (sinon il ne fait rien), mais le plus simple reste de respecter
-- l'ordre : migration d'abord, fichiers ensuite.
-- ================================================================


-- ÉTAPE 1 — LECTURE SEULE : exécuter cette ligne seule et regarder la colonne Type.
SHOW COLUMNS FROM rides LIKE 'status';

-- Type attendu (8 valeurs, dans cet ordre) :
--   enum('pending','accepted','arrived','started','completed','cancelled','cancelled_client','reported')
-- Si ta base affiche une valeur en plus ou en moins, NE LANCE PAS l'étape 2 :
-- l'ALTER ci-dessous remplace la liste entière et ferait perdre la valeur
-- absente de ma liste. Envoie-moi le résultat de l'étape 1.


-- ÉTAPE 2 — à exécuter seulement si l'étape 1 correspond. Ajoute 'expired'
-- à la fin de la liste : les courses existantes ne sont pas modifiées.
ALTER TABLE rides
  MODIFY COLUMN status ENUM('pending','accepted','arrived','started','completed','cancelled','cancelled_client','reported','expired') NOT NULL DEFAULT 'pending';

-- Vérification : le Type doit maintenant se terminer par ,'expired')
SHOW COLUMNS FROM rides LIKE 'status';


-- À SAVOIR : dès la mise en ligne des fichiers PHP, TOUTES les anciennes
-- courses 'pending' de plus de 30 min (courses abandonnées restées en base)
-- passeront en 'expired' à la première consultation. C'est voulu ; le
-- compteur "courses en attente" du tableau de bord baissera d'autant.
