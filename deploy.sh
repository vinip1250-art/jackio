#!/bin/bash

# ========================================
# Script de Deploy Automatizado para Jackettio en AWS EC2
# ========================================

set -e

echo "🚀 Iniciando instalación de Jackettio en AWS EC2..."
echo ""

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ========================================
# 1. Actualizar sistema
# ========================================
echo -e "${YELLOW}📦 Actualizando sistema...${NC}"
sudo apt update && sudo apt upgrade -y

# ========================================
# 2. Instalar Node.js 20 LTS
# ========================================
echo -e "${YELLOW}📦 Instalando Node.js 20 LTS...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

echo -e "${GREEN}✅ Node.js instalado:${NC}"
node --version
npm --version

# ========================================
# 3. Instalar dependencias del sistema
# ========================================
echo -e "${YELLOW}📦 Instalando Git y Nginx...${NC}"
sudo apt install -y git nginx

# ========================================
# 4. Instalar PM2 globalmente
# ========================================
echo -e "${YELLOW}📦 Instalando PM2...${NC}"
sudo npm install -g pm2

# ========================================
# 5. Instalar dependencias del proyecto
# ========================================
echo -e "${YELLOW}📦 Instalando dependencias de Node.js...${NC}"
npm install --production

# ========================================
# 6. Crear carpeta de datos persistentes
# ========================================
echo -e "${YELLOW}📁 Creando carpeta de datos...${NC}"
mkdir -p /home/ubuntu/jackettio-data
mkdir -p logs

# ========================================
# 7. Verificar archivo .env
# ========================================
if [ ! -f .env ]; then
    echo -e "${RED}⚠️  ADVERTENCIA: Archivo .env no encontrado${NC}"
    echo -e "${YELLOW}Creando .env desde .env.example...${NC}"
    cp .env.example .env
    echo -e "${RED}🔧 IMPORTANTE: Edita el archivo .env con tus credenciales:${NC}"
    echo -e "${YELLOW}   nano .env${NC}"
    echo ""
    read -p "Presiona ENTER cuando hayas configurado .env..."
fi

# ========================================
# 8. Configurar Nginx
# ========================================
echo -e "${YELLOW}🌐 Configurando Nginx...${NC}"
sudo cp nginx.conf /etc/nginx/sites-available/jackettio
sudo ln -sf /etc/nginx/sites-available/jackettio /etc/nginx/sites-enabled/jackettio
sudo rm -f /etc/nginx/sites-enabled/default

# Verificar configuración de Nginx
sudo nginx -t

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Configuración de Nginx válida${NC}"
    sudo systemctl restart nginx
    sudo systemctl enable nginx
else
    echo -e "${RED}❌ Error en configuración de Nginx${NC}"
    exit 1
fi

# ========================================
# 9. Iniciar aplicación con PM2
# ========================================
echo -e "${YELLOW}🚀 Iniciando Jackettio con PM2...${NC}"

# Detener proceso anterior si existe
pm2 delete jackettio 2>/dev/null || true

# Iniciar con PM2
pm2 start ecosystem.config.js

# Configurar PM2 para auto-inicio en reboot
pm2 startup systemd -u ubuntu --hp /home/ubuntu
pm2 save

echo -e "${GREEN}✅ Jackettio iniciado con PM2${NC}"

# ========================================
# 10. Configurar firewall (UFW)
# ========================================
echo -e "${YELLOW}🔒 Configurando firewall...${NC}"
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

# ========================================
# 11. Mostrar estado
# ========================================
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✅ Instalación completada exitosamente${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}📊 Estado de la aplicación:${NC}"
pm2 status

echo ""
echo -e "${YELLOW}🌐 Tu aplicación está disponible en:${NC}"
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
echo -e "${GREEN}   http://${PUBLIC_IP}${NC}"

echo ""
echo -e "${YELLOW}📝 Comandos útiles:${NC}"
echo -e "   ${GREEN}pm2 status${NC}          - Ver estado de la app"
echo -e "   ${GREEN}pm2 logs jackettio${NC}  - Ver logs en tiempo real"
echo -e "   ${GREEN}pm2 restart jackettio${NC} - Reiniciar app"
echo -e "   ${GREEN}pm2 stop jackettio${NC}  - Detener app"
echo -e "   ${GREEN}sudo systemctl status nginx${NC} - Estado de Nginx"

echo ""
echo -e "${YELLOW}🔐 Para configurar SSL/HTTPS:${NC}"
echo -e "   ${GREEN}sudo apt install certbot python3-certbot-nginx -y${NC}"
echo -e "   ${GREEN}sudo certbot --nginx -d tudominio.com${NC}"

echo ""
echo -e "${GREEN}🎉 ¡Listo! Jackettio está corriendo en producción${NC}"
