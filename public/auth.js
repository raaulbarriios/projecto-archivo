// public/auth.js

// This file must be loaded before any other script on protected pages.
document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('authToken');
    
    // Si no estamos en la página de login y no hay token, redirigir
    if (!window.location.pathname.endsWith('login.html') && !token) {
        window.location.href = 'login.html';
        return;
    }

    if (!window.location.pathname.endsWith('login.html')) {
        const logoutBtn = document.createElement('button');
        logoutBtn.textContent = 'Cerrar Sesión';
        logoutBtn.style.padding = '0.5rem 1rem';
        logoutBtn.style.background = 'rgba(244, 67, 54, 0.1)';
        logoutBtn.style.color = '#f44336';
        logoutBtn.style.border = '1px solid rgba(244, 67, 54, 0.3)';
        logoutBtn.style.borderRadius = '8px';
        logoutBtn.style.cursor = 'pointer';
        logoutBtn.style.fontWeight = '600';
        logoutBtn.style.transition = 'all 0.3s ease';

        logoutBtn.onmouseover = () => {
            logoutBtn.style.background = 'rgba(244, 67, 54, 0.2)';
        };
        logoutBtn.onmouseout = () => {
            logoutBtn.style.background = 'rgba(244, 67, 54, 0.1)';
        };

        logoutBtn.onclick = () => {
            localStorage.removeItem('authToken');
            localStorage.removeItem('authRole');
            localStorage.removeItem('authUsername');
            window.location.href = 'login.html';
        };

        const nav = document.querySelector('.top-nav') || document.querySelector('header');
        if (nav && nav.classList.contains('top-nav')) {
            logoutBtn.style.marginLeft = 'auto';
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
        config.headers['Authorization'] = `Bearer ${localStorage.getItem('authToken')}`;
    }
    const response = await originalFetch(resource, config);
    
    // Si el servidor devuelve 401 Unauthorized o 403 Forbidden y no estamos en login, redirigir
    if (response.status === 401 && !window.location.pathname.endsWith('login.html')) {
        localStorage.removeItem('authToken');
        window.location.href = 'login.html';
    }
    
    return response;
};

function getUserRole() {
    return localStorage.getItem('authRole') || 'user';
}

function getUsername() {
    return localStorage.getItem('authUsername') || 'Usuario';
}

function isAdmin() {
    return getUserRole() === 'admin';
}
