/**
 * LÉTRANGE Paris 1838 — Studio Authentication (Simplified Cloud)
 * Minimalist PIN gate to protect access without complex accounts.
 */
(function() {
    // 1. Initial State
    document.documentElement.style.visibility = 'hidden';

    // 2. Main Entry Point
    window.addEventListener('DOMContentLoaded', async () => {
        const body = document.body;
        if (!body) return;

        // Check if already logged in
        if (typeof ensureSupabaseSession === 'function') {
            const userId = await ensureSupabaseSession();
            if (userId) {
                document.documentElement.style.visibility = 'visible';
                return;
            }
        }

        const overlay = document.createElement('div');
        overlay.id = 'auth-gateway';
        overlay.innerHTML = `
            <div style="position: fixed; inset: 0; background: #ffffff; z-index: 100000; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: 'Inter', sans-serif;">
                <div style="width: 100%; max-width: 380px; text-align: center; padding: 2rem;">
                    <img src="Logo_Letrange_Paris_1838.webp" alt="LÉTRANGE" style="display:block; width: 220px; margin: 0 auto 4rem auto; filter: brightness(0);">
                    
                    <div style="margin-bottom: 2rem; text-align: left;">
                        
                        <div style="margin-bottom: 1.5rem;">
                            <label style="font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #999;">Email Professionnel</label>
                            <input type="email" id="email-input" placeholder="studio@letrange.paris"
                                style="width: 100%; border: none; border-bottom: 1.5px solid #eee; padding: 0.75rem 0; font-size: 14px; outline: none; transition: border-color 0.3s; font-family: 'Inter', sans-serif;">
                        </div>

                        <div style="margin-bottom: 2rem;">
                            <label style="font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #999;">Mot de Passe</label>
                            <input type="password" id="pass-input" placeholder="••••••••"
                                style="width: 100%; border: none; border-bottom: 1.5px solid #eee; padding: 0.75rem 0; font-size: 14px; outline: none; transition: border-color 0.3s; font-family: 'Inter', sans-serif;">
                        </div>

                        <button id="login-btn" style="width: 100%; background: #000; color: #fff; border: none; padding: 1rem; font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.3em; cursor: pointer; transition: opacity 0.3s;">
                            Se Connecter
                        </button>

                        <p id="auth-error" style="color: #ff0000; font-size: 9px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.2em; margin-top: 1.5rem; opacity: 0; transition: opacity 0.3s; text-align: center;">Identifiants Incorrects</p>
                    </div>

                    <div style="margin-top: 4rem;">
                        <p style="font-size: 9px; text-transform: uppercase; letter-spacing: 0.2em; color: #ccc; font-weight: bold; opacity: 0.5;">Production Cloud — LÉTRANGE Paris 1838</p>
                    </div>
                </div>
            </div>
        `;
        
        body.appendChild(overlay);
        document.documentElement.style.visibility = 'visible';
        
        const emailInput = document.getElementById('email-input');
        const passInput = document.getElementById('pass-input');
        const loginBtn = document.getElementById('login-btn');
        const error = document.getElementById('auth-error');

        async function handleLogin() {
            const email = emailInput.value;
            const pass = passInput.value;
            
            if (!email || !pass) return;
            
            loginBtn.disabled = true;
            loginBtn.style.opacity = '0.5';
            loginBtn.innerText = 'Connexion...';
            error.style.opacity = '0';

            const userId = await dbLogin(email, pass);
            
            if (userId) {
                overlay.style.opacity = '0';
                overlay.style.transition = 'opacity 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
                
                if (typeof migrateToCloud === 'function') await migrateToCloud();
                if (typeof initBoard === 'function') await initBoard();
                if (typeof initLibrary === 'function') await initLibrary();

                setTimeout(() => {
                    overlay.remove();
                }, 600);
            } else {
                loginBtn.disabled = false;
                loginBtn.style.opacity = '1';
                loginBtn.innerText = 'Se Connecter';
                error.innerText = dbGetLastError() || 'Identifiants Incorrects';
                error.style.opacity = '1';
                
                // Shake effect
                const box = loginBtn.parentElement;
                box.style.transform = 'translateX(10px)';
                setTimeout(() => box.style.transform = 'translateX(-10px)', 100);
                setTimeout(() => box.style.transform = 'translateX(0)', 200);
            }
        }

        loginBtn.addEventListener('click', handleLogin);
        
        // Enter key support
        [emailInput, passInput].forEach(el => {
            el.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleLogin();
            });
            el.addEventListener('focus', () => {
                el.style.borderBottomColor = '#000';
            });
            el.addEventListener('blur', () => {
                el.style.borderBottomColor = '#eee';
            });
        });
    });

})();
