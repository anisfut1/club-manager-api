Ce dossier ne sert jamais de contenu statique réel — `vercel.json` réécrit
TOUTES les requêtes vers la Function API (`rewrites: [{ source: "/(.*)",
destination: "/api" }]`). Il existe uniquement parce que Vercel, avec
`"framework": null` (nécessaire pour un vrai empaquetage esbuild, voir
`docs/DEPLOYMENT.md`), attend par défaut un dossier de sortie nommé
`public` après le build et fait échouer le déploiement s'il est absent
(`No Output Directory named "public" found`). Ne pas supprimer ce fichier.
