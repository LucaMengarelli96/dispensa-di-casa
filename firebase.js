// Collegamento a Firebase: accesso con Google e database Firestore con cache offline.
// La configurazione web di Firebase è pubblica per progetto: la sicurezza è data dalle regole Firestore.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocFromCache, setDoc, updateDoc, deleteDoc, collection, onSnapshot,
  query, where, writeBatch, arrayUnion, serverTimestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCgspbazrVlNVL2kpujFb0nNB4Kn3c9x2I',
  authDomain: 'dispensa-di-casa-246b9.firebaseapp.com',
  projectId: 'dispensa-di-casa-246b9',
  storageBucket: 'dispensa-di-casa-246b9.firebasestorage.app',
  messagingSenderId: '568272096904',
  appId: '1:568272096904:web:f77614e3c5ab279c37993d',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
auth.languageCode = 'it';

let firestore;
try {
  firestore = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (e) {
  // Browser senza IndexedDB (es. navigazione privata): funziona solo online
  firestore = initializeFirestore(app, {});
}
export const db = firestore;

export const signInWithGoogle = () => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider);
};

export {
  onAuthStateChanged, signOut,
  doc, getDoc, getDocFromCache, setDoc, updateDoc, deleteDoc, collection, onSnapshot,
  query, where, writeBatch, arrayUnion, serverTimestamp, deleteField,
};
