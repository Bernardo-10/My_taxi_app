<?php
/**
 * normalize.php — Lot 11 : normalisation des téléphones et des plaques.
 *
 * Problème de départ : « +237 6XX XXX XXX » et « 6XXXXXXXX » étaient deux
 * comptes différents, et « LT 123 » / « LT-123 » deux plaques différentes.
 *
 * Règles :
 *  - TÉLÉPHONE : forme canonique "+237" + 9 chiffres pour un numéro camerounais
 *    (9 chiffres commençant par 6 ou 2, avec ou sans 237 / 00237 / +237,
 *    espaces, points, tirets ou parenthèses ignorés). Un numéro étranger est
 *    accepté s'il commence par "+" ou "00" (8 à 15 chiffres) : "+" + chiffres.
 *  - PLAQUE : stockée en MAJUSCULES avec des espaces simples (plate_for_storage) ;
 *    COMPARÉE sans espaces, tirets, points ni soulignés (plate_key).
 *
 * Ce fichier ne dépend de rien : il s'inclut avec require_once.
 */

/**
 * Renvoie le numéro sous forme canonique, ou null s'il est inutilisable.
 */
function normalize_phone(string $raw): ?string {
    $raw = trim($raw);
    if ($raw === "") return null;

    // Seuls chiffres, espaces, +, points, tirets et parenthèses sont permis :
    // "abc677123456" est refusé au lieu d'être "nettoyé" en silence.
    if (!preg_match('/^[0-9\s+().\-]+$/', $raw)) return null;

    $hasPlus = ($raw[0] === "+");
    $digits  = preg_replace('/\D+/', '', $raw);
    if ($digits === "") return null;

    // "00237..." = "+237..." (préfixe international écrit à l'ancienne)
    if (strpos($digits, "00") === 0) {
        $digits  = substr($digits, 2);
        $hasPlus = true;
    }

    // Cameroun : 9 chiffres nationaux commençant par 6 (mobile) ou 2 (fixe)
    if (strlen($digits) === 9 && preg_match('/^[26]/', $digits)) {
        return "+237" . $digits;
    }
    if (strlen($digits) === 12 && strpos($digits, "237") === 0 && preg_match('/^[26]/', substr($digits, 3))) {
        return "+237" . substr($digits, 3);
    }

    // "+237..." de longueur incorrecte : numéro camerounais incomplet ou trop long, on refuse
    // (sinon il passerait pour un numéro étranger).
    if (strpos($digits, "237") === 0) return null;

    // Autre pays : on exige un préfixe international explicite
    if ($hasPlus && strlen($digits) >= 8 && strlen($digits) <= 15) {
        return "+" . $digits;
    }

    return null;
}

/**
 * Toutes les écritures « chiffres seulement » sous lesquelles ce numéro peut
 * déjà exister en base (comptes créés AVANT la normalisation).
 * Exemple : "+237677123456" -> ["237677123456", "00237677123456", "677123456"].
 */
function phone_digit_variants(string $canonical): array {
    $digits   = ltrim($canonical, "+");
    $variants = [$digits, "00" . $digits];
    if (strlen($digits) === 12 && strpos($digits, "237") === 0) {
        $variants[] = substr($digits, 3);          // forme nationale à 9 chiffres
    }
    return $variants;
}

/**
 * Expression SQL : la colonne téléphone réduite à ses chiffres (espaces, +,
 * tirets, points et parenthèses retirés). Sert à retrouver un compte ancien
 * (non migré) à partir d'une des formes de phone_digit_variants().
 * $col est toujours une constante de notre code, jamais une saisie utilisateur.
 */
function sql_phone_digits(string $col = "phone"): string {
    return "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE($col,' ',''),'+',''),'-',''),'.',''),'(',''),')','')";
}

/** Plaque telle qu'on l'enregistre : majuscules, espaces simples, sans espaces aux bords. */
function plate_for_storage(string $raw): string {
    $s = preg_replace('/\s+/u', ' ', trim($raw));
    return strtoupper($s === null ? trim($raw) : $s);
}

/** Clé de comparaison d'une plaque : « lt-123 ab » et « LT 123AB » donnent la même clé. */
function plate_key(string $raw): string {
    return strtoupper(preg_replace('/[\s\-._]+/u', '', $raw) ?? "");
}

/** Expression SQL équivalente à plate_key() pour une colonne (constante de notre code). */
function sql_plate_key(string $col = "plate"): string {
    return "UPPER(REPLACE(REPLACE(REPLACE(REPLACE($col,' ',''),'-',''),'.',''),'_',''))";
}
?>
