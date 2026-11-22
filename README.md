# Robia IoT — Administration des boutiques

Application React pour le propriétaire d'une organisation Robia. Elle utilise le compte existant et les contrôles d'accès du backend ; elle ne crée pas de compte administrateur local.

## Démarrer

```sh
npm install
npm run dev
```

Ouvrir l'adresse affichée (par défaut `http://localhost:5173`). L'API utilisée par défaut est `https://api.robiacopilot.site`. Pour un autre environnement, créer un fichier `.env.local` avec `VITE_API_URL=https://adresse-du-backend`, puis redémarrer Vite.

## Fonctions et limites

Le propriétaire peut créer une fiche, activer ou désactiver les rendez-vous, créer des créneaux futurs en heure de Madagascar, et affecter ou retirer un agent existant par son identifiant utilisateur. Seules les boutiques appartenant à son organisation sont visibles. Les réservations ne sont publiées que pour les boutiques également actives côté backend.

Le backend actuel ne propose pas de modification de fiche, de saisie manuelle des coordonnées ou de liste des agents affectés. Lors de la création, un identifiant Google Places reconnu par le backend peut renseigner les coordonnées ; sans celui-ci l'itinéraire peut être indisponible. La liste des créneaux est disponible lorsque la boutique est active et ouverte aux réservations. Le jeton est conservé uniquement en mémoire : un rechargement demande de se reconnecter.

## Mise en production

`npm run build` produit `dist/`. Servir le dossier en HTTPS. Ajouter l'origine exacte de l'interface à `FRONTEND_URLS` côté backend ; autrement, le navigateur bloquera les appels CORS. Tester avec un compte propriétaire autorisé et une boutique de test avant de gérer les données réelles.
