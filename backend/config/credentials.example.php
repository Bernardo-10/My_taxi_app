<?php
// Template d'identifiants de connexion à la base de données.
//
// Étapes pour un nouveau déploiement (nouveau serveur, nouveau compte
// InfinityFree, environnement local XAMPP...) :
//   1. Copier ce fichier sous le nom "credentials.php" dans ce même dossier
//   2. Remplacer les valeurs ci-dessous par les vraies (hôte, user, mot de
//      passe, nom de la base fournis par l'hébergeur ou ta config locale)
//   3. Ne JAMAIS committer credentials.php (il est déjà dans .gitignore)

return [
    "db_host" => "localhost",
    "db_user" => "changeme",
    "db_pass" => "changeme",
    "db_name" => "changeme",
];
