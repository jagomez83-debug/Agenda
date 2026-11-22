// ============================================================
//  CONFIGURACIÓN — lo único que hay que editar
// ============================================================

// 1) Pega aquí los datos de tu proyecto de Firebase
//    (Consola de Firebase → ⚙ Configuración del proyecto → Tus apps → Configuración)
export const firebaseConfig = {
  apiKey: "AIzaSyDV58BboiiFxeBT1ovENHp9hUTPAJulpgo",
  authDomain: "gomez-morato.firebaseapp.com",
  projectId: "gomez-morato",
  storageBucket: "gomez-morato.firebasestorage.app",
  messagingSenderId: "847689877360",
  appId: "1:847689877360:web:0ece5656dd4ad3579931b5",
  measurementId: "G-N0FCRYNLVZ"
};

// 2) Los ÚNICOS dos correos de Google que pueden entrar.
//    Deben ser los mismos que pongas en firestore.rules
export const CORREOS_PERMITIDOS = [
  "jagomez83@gmail.com",
  "liiz.morato@gmail.com"
];

// Cómo aparece cada quien en la app (se puede cambiar después en Ajustes)
export const NOMBRES = {
  "jagomez83@gmail.com": "Papá",
  "liiz.morato@gmail.com": "Mamá"
};

// 3) Clave para avisos con pantalla bloqueada (los envía el programa en Python)
//    Consola de Firebase → ⚙ Configuración del proyecto → Cloud Messaging →
//    Certificados push web → Generar par de claves → copia la "Clave pública"
export const VAPID_KEY = "BA8t9JmGsyt0_vxW2TPQ_ln2u-FP7vVGLQM_2Gphao-PTu4nKtB6LBqSFCPdEMnbMzRKT_xDwi5wERXWkf10xgQ";

// 4) Nombre que se ve en la app (opcional)
export const NOMBRE_APP = "Agenda familiar";
