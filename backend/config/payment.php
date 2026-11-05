<?php
/**
 * payment.php — Lot 8 : réglages des recharges du portefeuille chauffeur.
 *
 * ► À REMPLIR UNE FOIS : les numéros mobile money sur lesquels les chauffeurs
 *   doivent envoyer leur argent. Tant qu'un "number" est vide, l'application
 *   affiche seulement les étapes générales (sans numéro) : rien d'inventé.
 *
 * Ce fichier ne contient aucun secret (les numéros sont montrés aux chauffeurs
 * connectés). Il est lu par request_recharge.php (règles) et get_wallet.php
 * (affichage des instructions).
 */
return [
    // Opérateurs acceptés. La clé est EXACTEMENT le texte enregistré dans la base.
    //   number : numéro qui reçoit le paiement (ex : "6 90 00 00 00")
    //   holder : nom affiché par l'opérateur au moment de l'envoi (pour que le chauffeur vérifie)
    "operators" => [
        "Orange Money"     => ["number" => "", "holder" => ""],
        "MTN Mobile Money" => ["number" => "", "holder" => ""],
        "Express Union"    => ["number" => "", "holder" => ""],
    ],

    // Boutons de montant rapide (FCFA)
    "presets" => [2000, 5000, 10000, 20000],

    // Règles de sécurité (S-D) : appliquées par le SERVEUR, jamais seulement par le navigateur
    "min_amount_fcfa" => 1000,     // en dessous, une demande ne vaut pas le travail de validation
    "max_amount_fcfa" => 100000,   // plafond par demande
    "max_pending"     => 3,        // demandes en attente simultanées par chauffeur
    "reference_min"   => 6,        // longueur de l'identifiant de transaction mobile money
    "reference_max"   => 40,
];
