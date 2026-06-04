// public/auth.js

// This file must be loaded before any other script on protected pages.
document.addEventListener('DOMContentLoaded', () => {
    const token = sessionStorage.getItem('authToken');
    
    // Si no estamos en la página de login y no hay token, redirigir
    if (!window.location.pathname.endsWith('login.html') && !token) {
        window.location.href = 'login.html';
        return;
    }

    if (!window.location.pathname.endsWith('login.html')) {
        const logoutBtn = document.createElement('button');
        logoutBtn.textContent = 'Cerrar Sesión';
        logoutBtn.className = 'top-nav-btn logout-btn';

        logoutBtn.onclick = () => {
            sessionStorage.removeItem('authToken');
            sessionStorage.removeItem('authRole');
            sessionStorage.removeItem('authUsername');
            window.location.href = 'login.html';
        };

        const nav = document.querySelector('.top-nav') || document.querySelector('header');
        if (nav && nav.classList.contains('top-nav')) {
            const isIndex = window.location.pathname.endsWith('index.html') || window.location.pathname === '/' || window.location.pathname.endsWith('index');
            if (!isIndex) {
                logoutBtn.classList.add('logout-btn-auto-margin');
            }
            nav.appendChild(logoutBtn);
        } else {
            // Si no hay top-nav (ej: en index.html), lo añadimos de forma absoluta
            logoutBtn.style.position = 'absolute';
            logoutBtn.style.top = '1.5rem';
            logoutBtn.style.right = '1.5rem';
            document.body.appendChild(logoutBtn);
        }
    }

    if (!isAdmin()) {
        document.body.classList.add('role-user');
    }
});

// Configurar Fetch API de forma global para enviar el token JWT automáticamente
const originalFetch = window.fetch;
window.fetch = async function() {
    let [resource, config] = arguments;
    if(resource.startsWith('/api/') && resource !== '/api/login') {
        if(config === undefined) {
            config = {};
        }
        if(config.headers === undefined) {
            config.headers = {};
        }
        config.headers['Authorization'] = `Bearer ${sessionStorage.getItem('authToken')}`;
    }
    const response = await originalFetch(resource, config);
    
    // Si el servidor devuelve 401 Unauthorized o 403 Forbidden y no estamos en login, redirigir
    if (response.status === 401 && !window.location.pathname.endsWith('login.html')) {
        sessionStorage.removeItem('authToken');
        window.location.href = 'login.html';
    }
    
    return response;
};

function getUserRole() {
    return sessionStorage.getItem('authRole') || 'user';
}

function getUsername() {
    return sessionStorage.getItem('authUsername') || 'Usuario';
}

function isAdmin() {
    return getUserRole() === 'admin';
}
