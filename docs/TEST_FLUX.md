# 🧪 TEST DU FLUX COMPLET

## ✅ Étape 1 : Vérifiez la BD avec phpMyAdmin

1. Ouvrez http://localhost/phpmyadmin
2. Allez dans `taxi_app` > `rides`
3. Insérez une course de test avec statut `'pending'`:
   ```sql
   INSERT INTO rides (pickup, destination, pickup_lat, pickup_lng, destination_lat, destination_lng, distance_km, duration_min, price_fcfa, passengers, status, user_id)
   VALUES ('Test Pickup', 'Test Destination', 4.05, 9.76, 4.06, 9.77, 5.0, 10, 500, 1, 'pending', 1);
   ```

## ✅ Étape 2 : Test Chauffeur - Accepter une course

1. Ouvrez votre interface chauffeur (chauffeur.html)
2. Vous verrez la course en "En attente"
3. Cliquez sur "Accepter"
4. **Vérifiez :**
   - ✅ Vous obtenez une alerte "Course acceptée 🚕"
   - ✅ Ouvrez la **console (F12)** et cherchez les logs:
     ```
     ✅ Position GPS obtenue: Lat=...
     📡 Réponse serveur: {status: "ok", ...}
     ```

## ✅ Étape 3 : Vérifiez la BD (accept_ride.php)

1. Allez dans phpMyAdmin et rechargez la table `rides`
2. **La course acceptée doit avoir:**
   - `status` = `'accepted'`
   - `driver_lat` ≠ NULL (doit avoir une valeur)
   - `driver_lng` ≠ NULL (doit avoir une valeur)
   - `driver_name` = `'Test Driver'`
   - `driver_plate` = `'LT 000 BD'`

**Si les colonnes driver_lat/driver_lng sont NULL**, alors le GPS a échoué côté chauffeur.

## ✅ Étape 4 : Vérifiez les logs PHP

1. Ouvrez le fichier log PHP:
   ```
   C:\xampp\apache\logs\error.log
   ```
2. Cherchez les lignes avec `=== ACCEPT_RIDE DEBUG ===`
3. Vous devriez voir:
   ```
   === ACCEPT_RIDE DEBUG ===
   Données reçues: {"id":1,"driver_lat":4.0511,"driver_lng":9.7679}
   ID: 1, Lat: 4.0511, Lng: 9.7679
   Course trouvée - Status actuel: pending
   Affected rows: 1
   Valeurs en BD: Lat=4.0511, Lng=9.7679, Status=accepted
   ```

## ✅ Étape 5 : Test Client - Voir le taxi

1. Ouvrez votre interface client (index.html)
2. Créez une course de test (utilisez les mêmes coordonnées)
3. Une fois acceptée par le chauffeur, vous devriez voir:
   - ✅ Un message "✅ Course acceptée par Test Driver (LT 000 BD) 🚕"
   - ✅ Une icône 🚕 qui s'affiche sur la carte à la position du chauffeur

## ✅ Étape 6 : Vérifiez les logs côté client

1. Ouvrez **la console du client (F12)**
2. Cherchez les logs:
   ```
   🔄 Récupération position chauffeur pour course #1
   📡 Réponse serveur: {status: "success", driver_lat: ..., driver_lng: ...}
   📍 Position chauffeur reçue: Lat=4.0511, Lng=9.7679
   🚕 Création du marqueur taxi
   ```

## 🐛 Dépannage

### ❌ Problème: "Position GPS non disponible"
- **Cause:** Le navigateur a refusé l'accès au GPS
- **Solution:** 
  1. Vérifiez que HTTPS est activé (ou localhost)
  2. Autorisez l'accès au GPS dans les paramètres du navigateur
  3. Relancez le test

### ❌ Problème: driver_lat/driver_lng sont NULL en BD
- **Cause:** Le GPS n'a pas retourné de coordonnées
- **Solution:**
  1. Vérifiez la console du navigateur pour les erreurs GPS
  2. Attendez plus longtemps (GPS peut être lent)
  3. Activez le GPS physique de votre appareil

### ❌ Problème: L'icône taxi ne s'affiche pas côté client
- **Cause:** get_driver_location.php retourne une erreur
- **Solution:**
  1. Vérifiez la console côté client (F12)
  2. Vérifiez les logs PHP dans error.log
  3. Vérifiez que la course a bien `status='accepted'` en BD

## 📊 Points à vérifier dans phpMyAdmin

Après l'acceptation d'une course, vérifiez dans **taxi_app > rides**:

| Colonne | Valeur attendue |
|---------|-----------------|
| `id` | ex: 1 |
| `status` | `'accepted'` |
| `driver_lat` | ex: 4.0511 |
| `driver_lng` | ex: 9.7679 |
| `driver_name` | `'Test Driver'` |
| `driver_plate` | `'LT 000 BD'` |
| `update_position_driver` | Date/heure récente |

