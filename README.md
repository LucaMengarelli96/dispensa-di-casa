# Dispensa di Casa

Web app di famiglia per lista della spesa, scorte di frigo, dispensa e freezer, ricette e promemoria ricorrenti. Si installa sul telefono (iPhone e Android) e funziona anche senza campo.

## Come è fatta

| Parte | Tecnologia |
| --- | --- |
| App | HTML + JavaScript senza build, installabile (PWA): `index.html`, `app.js`, `styles.css`, `sw.js` |
| Dati condivisi | Firebase Firestore con cache offline (progetto `dispensa-di-casa-246b9`, regione eur3) |
| Accesso | Account Google tramite Firebase Authentication |
| Codici a barre | Libreria html5-qrcode + database Open Food Facts |
| Hosting | GitHub Pages |
| Lettura scontrini | Script Apps Script `apps-script/Code.gs` (web app) che chiama Gemini Flash |

## Dati in Firestore

- `users/{uid}`: a quale famiglia appartiene l'utente
- `households/{id}`: nome, membri, nomi visualizzati
- `households/{id}/stock`: scorte (nome, quantità, unità, posto, scadenza, scorta minima, reparto)
- `households/{id}/list`: lista della spesa
- `households/{id}/recipes`: ricette con ingredienti
- `households/{id}/reminders`: acquisti periodici
- `households/{id}/purchases`: prezzi pagati
- `households/{id}/barcodes`: nomi scelti per ogni codice a barre
- `households/{id}/aliases`: correzioni dei nomi letti dagli scontrini

Le regole di sicurezza sono in `firestore.rules` e vanno copiate nella console Firebase (Firestore → Regole).

## Invitare la famiglia

Dal pallino in alto a destra: «Condividi link». Chi apre il link e accede con Google entra nella stessa dispensa.

## Server Apps Script

Il codice è in `apps-script/Code.gs` ed è pubblicato come applicazione web sul progetto «Dispensa di Casa - Server».
Dopo ogni modifica: Esegui il deployment → Gestisci deployment → modifica (matita) → Versione: Nuova versione → Esegui il deployment. L'indirizzo resta lo stesso.
La chiave Gemini sta solo nelle proprietà dello script (`GEMINI_API_KEY`). Modello principale: Gemini 3.5 Flash-Lite (costante MODELLO_PREFERITO, oppure proprietà GEMINI_MODEL); se non risponde lo script passa da solo agli altri Flash-Lite e poi ai Flash.

## Prossimi passi

- «Suggeriscimi qualcosa» e import di ricette da link
- Notifiche push dei promemoria
