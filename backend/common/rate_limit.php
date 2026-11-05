<?php
/**
 * rate_limit.php — Chantier S-A : limiteur de tentatives (connexion et inscription).
 *
 * Principe : chaque ÉCHEC de connexion (et chaque inscription) est noté dans la
 * table `login_attempts`. Avant de traiter une nouvelle tentative, on compte
 * les notes récentes ; au-delà du plafond, on répond 429 "réessayez dans N min".
 *
 *   Connexion : 5 échecs / 15 min pour le même (adresse IP + identifiant)
 *               30 échecs / 15 min pour une même adresse IP (tous identifiants)
 *   Inscription : 5 inscriptions / heure pour une même adresse IP
 *
 * Pourquoi IP + identifiant (et pas l'identifiant seul) : avec l'identifiant seul,
 * n'importe qui pourrait bloquer le compte d'un autre chauffeur en tapant 5 fois
 * un faux mot de passe. Pourquoi un plafond plus large par IP : au Cameroun,
 * beaucoup de téléphones partagent l'adresse IP de l'opérateur ; un plafond serré
 * par IP bloquerait des chauffeurs honnêtes ensemble.
 *
 * Sécurité de fonctionnement : si la table n'existe pas encore (migration SQL pas
 * passée) ou si la base répond mal, le limiteur "laisse passer" au lieu de
 * bloquer tout le monde. Seules les adresses IP et un empreinte (SHA-256) de
 * l'identifiant sont stockées : jamais le texte saisi.
 */

const RL_LOGIN_MAX_IDENT   = 5;      // échecs max par (IP + identifiant)
const RL_LOGIN_MAX_IP      = 30;     // échecs max par IP
const RL_LOGIN_WINDOW      = 900;    // 15 minutes (en secondes)
const RL_REGISTER_MAX_IP   = 5;      // inscriptions max par IP
const RL_REGISTER_WINDOW   = 3600;   // 1 heure

/**
 * Adresse IP du visiteur. On lit REMOTE_ADDR uniquement : les en-têtes
 * X-Forwarded-For & co sont écrits par le visiteur et donc falsifiables.
 * Si l'hébergeur place un proxy devant le site, toutes les adresses se
 * ressembleront : voir LISEZ-MOI (vérification à faire une fois en ligne).
 */
function rl_ip(): string {
    $ip = $_SERVER["REMOTE_ADDR"] ?? "";
    return filter_var($ip, FILTER_VALIDATE_IP) ? substr($ip, 0, 45) : "0.0.0.0";
}

/** Empreinte de l'identifiant saisi (insensible à la casse et aux espaces autour). */
function rl_ident(string $login): string {
    return hash("sha256", mb_strtolower(trim($login)));
}

/**
 * Nombre de secondes à attendre avant de pouvoir réessayer (0 = autorisé).
 * Le blocage dure $window secondes à partir de la DERNIÈRE tentative notée ;
 * les tentatives refusées ne sont pas notées, donc il ne se prolonge pas.
 */
function rl_wait_seconds(mysqli $conn, string $scope, string $ip, ?string $ident, int $max, int $window): int {
    try {
        $since = time() - $window;
        if ($ident === null) {
            $stmt = $conn->prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM login_attempts
                                    WHERE scope = ? AND ip = ? AND created_at > ?");
            $stmt->bind_param("ssi", $scope, $ip, $since);
        } else {
            $stmt = $conn->prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM login_attempts
                                    WHERE scope = ? AND ip = ? AND ident = ? AND created_at > ?");
            $stmt->bind_param("sssi", $scope, $ip, $ident, $since);
        }
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if ((int) ($row["n"] ?? 0) >= $max) {
            return max(1, $window - (time() - (int) $row["last_at"]));
        }
    } catch (Throwable $e) {
        error_log("[rate_limit] lecture impossible (table login_attempts créée ?) : " . $e->getMessage());
    }
    return 0;   // en cas de doute, on laisse passer
}

/** Note une tentative (échec de connexion, inscription...). */
function rl_record(mysqli $conn, string $scope, string $ip, string $ident): void {
    try {
        $now = time();
        $stmt = $conn->prepare("INSERT INTO login_attempts (scope, ip, ident, created_at) VALUES (?, ?, ?, ?)");
        $stmt->bind_param("sssi", $scope, $ip, $ident, $now);
        $stmt->execute();
        $stmt->close();
        // Ménage : de temps en temps, on efface les notes de plus de 24 h (pas de cron sur InfinityFree)
        if (random_int(1, 50) === 1) {
            $old = $now - 86400;
            $del = $conn->prepare("DELETE FROM login_attempts WHERE created_at < ?");
            $del->bind_param("i", $old);
            $del->execute();
            $del->close();
        }
    } catch (Throwable $e) {
        error_log("[rate_limit] écriture impossible : " . $e->getMessage());
    }
}

/** Efface les échecs d'un couple (IP + identifiant) après une connexion réussie. */
function rl_clear(mysqli $conn, string $scope, string $ip, string $ident): void {
    try {
        $stmt = $conn->prepare("DELETE FROM login_attempts WHERE scope = ? AND ip = ? AND ident = ?");
        $stmt->bind_param("sss", $scope, $ip, $ident);
        $stmt->execute();
        $stmt->close();
    } catch (Throwable $e) {
        error_log("[rate_limit] nettoyage impossible : " . $e->getMessage());
    }
}

/** Réponse 429 commune : message en minutes + en-tête Retry-After. */
function rl_block_response(int $waitSeconds, string $what = "tentatives"): void {
    $minutes = (int) ceil($waitSeconds / 60);
    header("Retry-After: " . $waitSeconds);
    json_response(["status" => "error",
        "message" => "Trop de " . $what . ". Réessayez dans " . $minutes . " minute" . ($minutes > 1 ? "s" : "") . ".",
        "retry_after" => $waitSeconds], 429);
}
