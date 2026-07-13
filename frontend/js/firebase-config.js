// TaxiGo — Configuration Firebase partagée (client + chauffeur)
//
// IMPORTANT : contrairement à credentials.php ou au fichier de compte de
// service, ce bloc n'est PAS un secret — c'est la configuration publique
// que Firebase donne pour identifier ton projet depuis le navigateur.
// Elle est destinée à être visible côté client (elle apparaît de toute
// façon dans le code source de la page). Ce qui doit rester secret, c'est
// uniquement le fichier backend/config/firebase-service-account.json.
//
// À REMPLIR avec les valeurs copiées à l'étape B (bloc firebaseConfig)
// et à l'étape C (clé VAPID) de la console Firebase.

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAsWPOMM5Gj0ChZ2m5NXnsE047FBj5oz2U",
  authDomain: "taxigo-cmr.firebaseapp.com",
  projectId: "taxigo-cmr",
  storageBucket: "taxigo-cmr.firebasestorage.app",
  messagingSenderId: "963012469300",
  appId: "1:963012469300:web:22c004ae6fa4e7bf12e061",
};

// Clé publique VAPID générée dans Firebase Console > Paramètres du projet
// > Cloud Messaging > Configuration Web > Générer une paire de clés.
const FCM_VAPID_KEY = "BGzxBZs_mbAvzuVfkS7flwLxwUUtRLm0aQsGWmEa_he9KgW6nkZa4dXAnQq_YeC39am_2FqCk5AaDtol7akksyg";
