/** Téléchargement d'un blob depuis la page (pas de navigation : le garde ne s'en mêle pas). */
export const DOWNLOAD_JS = "const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['contenu grasp'])); a.download = 'grasp-dl.txt'; document.body.append(a); a.click(); 'ok'";
