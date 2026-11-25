# Robia IoT — Administration des boutiques

Application React pour le propriétaire d'une organisation Robia. Elle utilise le compte existant et les contrôles d'accès du backend ; elle ne crée pas de compte administrateur local.

## Démarrer

```sh
npm install
npm run dev
```

Ouvrir l'adresse affichée (par défaut `http://localhost:5173`). L'API utilisée par défaut est `https://api.robiacopilot.site`. Pour un autre environnement, créer un fichier `.env.local` avec `VITE_API_URL=https://adresse-du-backend`, puis redémarrer Vite.

## Fonctions

- **Créer une boutique** en la recherchant sur Google (`/locations/search-places`) : l'adresse et la position GPS sont remplies automatiquement. La position est indispensable à l'itinéraire et à la vérification du trajet dans l'application mobile.
- **Checklist « prête à recevoir »** : position GPS, créneaux disponibles, au moins un agent, publication.
- **Publier ou suspendre** les réservations d'une boutique.
- **Planifier les créneaux** sur une période (jusqu'à 62 jours) : jours, plage horaire, durée et nombre de places, avec un aperçu avant publication. Le backend refuse tout créneau hors des horaires d'accueil (lundi–samedi, 08:00–16:00, heure de Madagascar) et ignore les doublons.
- **Ajuster la capacité** d'un créneau (jamais sous le nombre de places déjà réservées) ou supprimer un créneau encore vide.
- **Gérer l'équipe** : ajouter un agent avec l'adresse e-mail de son compte Robia, voir et retirer les agents d'une boutique.
- **Indicateurs** de la boutique sélectionnée : demandes en attente, rendez-vous du jour, taux de remplissage des 7 prochains jours, équipe, activité récente.
- **Fermer une journée** (jour férié, fermeture exceptionnelle) : les créneaux vides sont supprimés, ceux déjà réservés n'acceptent plus de nouvelles réservations.
- Un compte qui n'est propriétaire d'aucune organisation voit un écran explicatif. Définir `VITE_SHOP_DASHBOARD_URL` pour y afficher un lien vers l'espace boutique.
- Fenêtres accessibles au clavier (Échap pour fermer), bandeau hors connexion, titre d'onglet contextuel.

Seules les boutiques de l'organisation du compte connecté sont visibles. La session est conservée dans l'onglet (sessionStorage) et disparaît à sa fermeture.

## Mise en production

`npm run build` produit `dist/`. Servir le dossier en HTTPS. Ajouter l'origine exacte de l'interface à `FRONTEND_URLS` côté backend ; autrement, le navigateur bloquera les appels CORS. Tester avec un compte propriétaire et une boutique de test avant de gérer les données réelles.
