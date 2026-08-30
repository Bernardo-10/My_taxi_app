Dépose ici les 5 fichiers son (courts, MP3 ou OGG, idéalement < 20 Ko chacun) :

  accepted.mp3    -> son1 (client : chauffeur a accepté)
  arrived.mp3     -> son2 (client : chauffeur arrivé)
  cancelled.mp3   -> son3 (annulation par l'autre partie, client ET chauffeur)
  new_ride.mp3    -> son4 (chauffeur : nouvelle course disponible, un peu plus long)
  admin_alert.mp3 -> son5 (admin : nouvelle recharge en attente OU nouveau document KYC en attente/renouvellement)

Le fichier frontend/js/notify-feedback.js référence exactement ces noms.
Si tu préfères le format .ogg, remplace simplement l'extension dans
SOUND_FILES en haut de notify-feedback.js.
