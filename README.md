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

## Dati in Firestore

- `users/{uid}`: a quale famiglia appartiene l'utente
- `households/{id}`: nome, membri, nomi visualizzati
- `households/{id}/stock`: scorte (nome, quantità, unità, posto, scadenza, scorta minima, reparto)
- `households/{id}/list`: lista della spesa
- `households/{id}/recipes`: ricette con ingredienti
- `households/{id}/reminders`: acquisti periodici
- `households/{id}/purchases`: prezzi pagati
- `households/{id}/barcodes`: nomi scelti per ogni codice a barre

Le regole di sicurezza sono in `firestore.rules` e vanno copiate nella console Firebase (Firestore → Regole).

## Invitare la famiglia

Dal pallino in alto a destra: «Condividi link». Chi apre il link e accede con Google entra nella stessa dispensa.

## Prossima versione

- Foto dello scontrino letta dall'AI (Gemini)
- «Suggeriscimi qualcosa» e import di ricette da link
- Notifiche dei promemoria (Apps Script)
