Maintenant je trace comment `is_online` est réellement mis à jour côté chauffeur, et si le client a un équivalent.## Colonne "Statut" — analyse complète

**Côté client** : simple. `Statut` = `userStatusBadge(c.status)`, uniquement `active`/`disabled` — le compte est activé ou désactivé par toi depuis l'admin (bouton "Activer"/"Désactiver"). C'est purement administratif. Il n'y a d'ailleurs **aucune colonne `is_online` dans la table `client`** (vérifié dans `schema.sql`) — le concept "en ligne" n'existe tout simplement pas côté client, ce qui est cohérent : un client n'a pas besoin d'être suivi en direct comme un chauffeur.

**Côté chauffeur** : la cellule combine deux informations indépendantes :
- Badge vert **"En ligne"** / rouge **"Inactif"** → basé uniquement sur `c.is_online`
- Badge gris **"Désactivé"** en plus, si `c.status !== 'active'` (compte désactivé par toi)

## Quand un chauffeur est-il "en ligne" ?

J'ai tracé `is_online` de bout en bout. C'est un booléen **purement déclaratif** :

- Il n'est modifié que par `backend/chauffeur/set_driver_status.php`, appelé uniquement quand le chauffeur bascule manuellement le toggle dans son interface.
- **Rien ne le repasse à 0 automatiquement.** J'ai vérifié les trois points de sortie possibles :
  - `logout.php` (déconnexion) : détruit la session, ne touche pas à `is_online`.
  - `beforeunload` → `cleanup()` (fermeture d'onglet) : nettoie seulement le GPS watch et les timers côté client, aucun appel réseau vers le serveur.
  - Aucune expiration côté serveur basée sur l'inactivité (pas de cron sur InfinityFree, et aucune logique "lazy" équivalente n'a été mise en place pour ça, contrairement à d'autres endroits du projet comme l'expiration des courses `pending`).

**Conséquence concrète** : un chauffeur qui ferme son onglet, perd sa connexion, ou dont le téléphone s'éteint, reste marqué "En ligne" (vert) indéfiniment dans ton tableau Chauffeurs — jusqu'à ce qu'il rouvre l'app et bascule lui-même le toggle.

## Incohérence trouvée avec le reste de l'admin

Deux autres endroits du projet appliquent en plus une **condition de fraîcheur** (`update_position_driver >= NOW() - 10 minutes`), que le tableau Chauffeurs n'applique pas :
- `backend/admin/driver_positions.php` (carte temps réel)
- `backend/client/nearby_drivers.php` (chantier 3, que je viens de modifier)

Résultat : un chauffeur avec `is_online = 1` mais une position vieille de plusieurs heures **disparaît de la carte** mais reste affiché **"En ligne" (vert)** dans le tableau Chauffeurs — deux vues admin qui se contredisent sur le même chauffeur au même instant.

**Effet de bord supplémentaire** : `backend/admin/get_stats.php` calcule le KPI **"chauffeurs actifs"** du dashboard avec `SUM(is_online = 1)`, sans filtre de fraîcheur non plus — ce chiffre peut donc être gonflé par des chauffeurs déconnectés depuis longtemps.

Veux-tu que j'aligne le tableau Chauffeurs (et/ou le KPI du dashboard) sur le même critère de fraîcheur que la carte et la liste des chauffeurs à proximité ?