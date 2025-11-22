# 🚀 Guía de Despliegue de Jackettio en AWS EC2

Esta guía te llevará paso a paso para desplegar Jackettio en Amazon Web Services (AWS) EC2.

## 📋 Requisitos Previos

Antes de comenzar, asegúrate de tener:

- ✅ Cuenta de AWS (puedes usar Free Tier)
- ✅ Conocimientos básicos de terminal/SSH
- ✅ Una instancia de Jackett funcionando (puede estar en la misma EC2 o separada)
- ✅ API Key de Jackett
- ✅ (Opcional) Dominio propio para configurar SSL/HTTPS

---

## 🖥️ Paso 1: Crear Instancia EC2

### 1.1 Acceder a AWS Console
1. Inicia sesión en [AWS Console](https://console.aws.amazon.com)
2. Busca "EC2" en el buscador
3. Haz clic en "Launch Instance" (Lanzar Instancia)

### 1.2 Configurar la Instancia

**Nombre y etiquetas:**
- Nombre: `jackettio-server` (o el que prefieras)

**Imagen de aplicación y sistema operativo:**
- **Sistema Operativo**: Ubuntu Server 22.04 LTS (64-bit x86)
- Arquitectura: 64-bit (x86)

**Tipo de instancia:**
- Para pruebas: `t2.micro` (Free tier eligible - 1 vCPU, 1 GB RAM)
- Para producción: `t3.small` o superior (2 vCPU, 2 GB RAM)

**Par de claves (Key pair):**
- Clic en "Create new key pair"
- Nombre: `jackettio-key` (o el que prefieras)
- Tipo: RSA
- Formato: `.pem` (para Linux/Mac) o `.ppk` (para Windows con PuTTY)
- **⚠️ IMPORTANTE**: Descarga y guarda este archivo en un lugar seguro

**Configuración de red:**
- Marca "Allow SSH traffic from" → Selecciona "My IP" (más seguro)
- ✅ Marca "Allow HTTP traffic from the internet"
- ✅ Marca "Allow HTTPS traffic from the internet"

**Almacenamiento:**
- 20 GB de almacenamiento (suficiente para empezar)
- Tipo: gp3 (General Purpose SSD)

### 1.3 Lanzar Instancia
- Haz clic en "Launch Instance"
- Espera 2-3 minutos mientras se inicializa

### 1.4 Obtener IP Pública
1. Ve a "Instances" en el panel izquierdo
2. Selecciona tu instancia
3. Copia la **Public IPv4 address** (algo como: `54.123.45.67`)

---

## 🔌 Paso 2: Conectarse a la Instancia EC2

### Desde Linux/Mac:

```bash
# Dar permisos al archivo .pem
chmod 400 jackettio-key.pem

# Conectar por SSH
ssh -i jackettio-key.pem ubuntu@TU_IP_PUBLICA
```

### Desde Windows:

**Opción A - PowerShell/CMD:**
```powershell
ssh -i jackettio-key.pem ubuntu@TU_IP_PUBLICA
```

**Opción B - PuTTY:**
1. Convierte el archivo `.pem` a `.ppk` usando PuTTYgen
2. Usa PuTTY para conectarte con la clave `.ppk`

### Desde Celular:

**Apps recomendadas:**
- **Android**: Termius, JuiceSSH
- **iOS**: Termius, Blink Shell

1. Descarga la app
2. Agrega nueva conexión SSH
3. Host: Tu IP pública
4. Usuario: `ubuntu`
5. Importa el archivo `.pem` como clave privada

---

## 📥 Paso 3: Subir el Código a EC2

### Opción A: Clonar desde GitHub (Recomendado)

```bash
# En la instancia EC2
git clone https://github.com/TU_USUARIO/jackettio.git
cd jackettio
```

### Opción B: Transferencia directa con SCP

```bash
# Desde tu máquina local (no en EC2)
scp -i jackettio-key.pem -r ./jackettio ubuntu@TU_IP_EC2:/home/ubuntu/
```

### Opción C: Comprimir y subir

```bash
# En tu máquina local
tar -czf jackettio.tar.gz ./jackettio
scp -i jackettio-key.pem jackettio.tar.gz ubuntu@TU_IP_EC2:/home/ubuntu/

# En EC2
tar -xzf jackettio.tar.gz
cd jackettio
```

---

## ⚙️ Paso 4: Instalación Automática

### 4.1 Ejecutar Script de Deploy

El proyecto incluye un script que hace toda la instalación automáticamente:

```bash
# Dar permisos de ejecución al script
chmod +x deploy.sh

# Ejecutar script
./deploy.sh
```

El script hará automáticamente:
- ✅ Actualizar el sistema
- ✅ Instalar Node.js 20 LTS
- ✅ Instalar PM2 (gestor de procesos)
- ✅ Instalar Nginx (servidor web)
- ✅ Instalar dependencias del proyecto
- ✅ Crear carpetas necesarias
- ✅ Configurar Nginx como proxy reverso
- ✅ Configurar firewall
- ✅ Iniciar la aplicación

### 4.2 Configurar Variables de Entorno

El script te pedirá configurar el archivo `.env`:

```bash
nano .env
```

**Configuración mínima necesaria:**

```bash
# OBLIGATORIO
JACKETT_URL=http://localhost:9117
JACKETT_API_KEY=tu_api_key_de_jackett

# IMPORTANTE - Usar ruta persistente en producción
DATA_FOLDER=/home/ubuntu/jackettio-data
PORT=4000
```

Guarda el archivo: `Ctrl + O`, `Enter`, `Ctrl + X`

---

## 🔧 Paso 5: Instalación Manual (Alternativa)

Si prefieres hacerlo paso a paso sin el script:

```bash
# 1. Actualizar sistema
sudo apt update && sudo apt upgrade -y

# 2. Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Instalar dependencias del sistema
sudo apt install -y git nginx

# 4. Instalar PM2
sudo npm install -g pm2

# 5. Ir a la carpeta del proyecto
cd jackettio

# 6. Instalar dependencias
npm install --production

# 7. Crear carpetas
mkdir -p /home/ubuntu/jackettio-data
mkdir -p logs

# 8. Configurar .env
cp .env.example .env
nano .env

# 9. Configurar Nginx
sudo cp nginx.conf /etc/nginx/sites-available/jackettio
sudo ln -s /etc/nginx/sites-available/jackettio /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# 10. Iniciar con PM2
pm2 start ecosystem.config.js
pm2 startup
pm2 save
```

---

## 🎯 Paso 6: Verificar que Funciona

### 6.1 Verificar PM2
```bash
pm2 status
```

Deberías ver algo como:
```
┌─────┬───────────┬─────────┬──────┬─────┐
│ id  │ name      │ status  │ cpu  │ mem │
├─────┼───────────┼─────────┼──────┼─────┤
│ 0   │ jackettio │ online  │ 0%   │ 45M │
└─────┴───────────┴─────────┴──────┴─────┘
```

### 6.2 Ver Logs
```bash
pm2 logs jackettio
```

### 6.3 Probar en el Navegador

Abre tu navegador y ve a:
```
http://TU_IP_PUBLICA
```

Deberías ver la página de configuración de Jackettio.

---

## 🔐 Paso 7: Configurar SSL/HTTPS (Opcional pero Recomendado)

### 7.1 Requisitos
- Tener un dominio apuntando a tu IP de EC2
- Ejemplo: `jackettio.tudominio.com` → `54.123.45.67`

### 7.2 Instalar Certbot
```bash
sudo apt install certbot python3-certbot-nginx -y
```

### 7.3 Obtener Certificado SSL
```bash
sudo certbot --nginx -d jackettio.tudominio.com
```

Certbot hará automáticamente:
- ✅ Obtener certificado SSL gratis de Let's Encrypt
- ✅ Configurar Nginx para HTTPS
- ✅ Crear redirección HTTP → HTTPS
- ✅ Configurar renovación automática

### 7.4 Verificar Renovación Automática
```bash
sudo certbot renew --dry-run
```

---

## 📦 Paso 8: Instalar Jackett (si no lo tienes)

### 8.1 Descargar e Instalar Jackett

```bash
cd /opt
sudo wget https://github.com/Jackett/Jackett/releases/latest/download/Jackett.Binaries.LinuxAMDx64.tar.gz
sudo tar -xzf Jackett.Binaries.LinuxAMDx64.tar.gz
sudo rm Jackett.Binaries.LinuxAMDx64.tar.gz
```

### 8.2 Iniciar Jackett
```bash
cd /opt/Jackett
./jackett
```

### 8.3 Configurar Jackett como Servicio
```bash
sudo nano /etc/systemd/system/jackett.service
```

Pega esto:
```ini
[Unit]
Description=Jackett
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/Jackett
ExecStart=/opt/Jackett/jackett --NoRestart
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable jackett
sudo systemctl start jackett
sudo systemctl status jackett
```

### 8.4 Acceder a Jackett

Abre: `http://TU_IP_EC2:9117`

**⚠️ IMPORTANTE**: Copia el API Key que aparece en la página de Jackett y agrégalo a tu `.env` de Jackettio.

---

## 🛠️ Comandos Útiles

### PM2 (Gestión de la App)
```bash
pm2 status                # Ver estado
pm2 logs jackettio        # Ver logs en tiempo real
pm2 restart jackettio     # Reiniciar app
pm2 stop jackettio        # Detener app
pm2 delete jackettio      # Eliminar de PM2
pm2 monit                 # Monitor en tiempo real
```

### Nginx (Servidor Web)
```bash
sudo systemctl status nginx    # Ver estado
sudo systemctl restart nginx   # Reiniciar
sudo systemctl stop nginx      # Detener
sudo nginx -t                  # Verificar configuración
sudo tail -f /var/log/nginx/error.log  # Ver errores
```

### Actualizar Código
```bash
cd /home/ubuntu/jackettio
git pull origin main          # Traer cambios
npm install                   # Instalar nuevas dependencias
pm2 restart jackettio         # Reiniciar app
```

---

## 🔍 Troubleshooting (Solución de Problemas)

### Problema: "502 Bad Gateway"
```bash
# Verificar que la app esté corriendo
pm2 status

# Ver logs de la app
pm2 logs jackettio

# Reiniciar app
pm2 restart jackettio
```

### Problema: No se puede conectar por SSH
- Verifica que el Security Group permita puerto 22
- Verifica que estés usando la IP pública correcta
- Verifica permisos del archivo .pem: `chmod 400 jackettio-key.pem`

### Problema: No carga la página
```bash
# Verificar Nginx
sudo systemctl status nginx

# Ver errores de Nginx
sudo tail -f /var/log/nginx/error.log

# Verificar firewall
sudo ufw status
```

### Problema: La app se cierra sola
```bash
# Ver logs de errores
pm2 logs jackettio --err

# Verificar memoria
free -h

# Aumentar memoria permitida en ecosystem.config.js
max_memory_restart: '1G'
```

---

## 🎉 ¡Listo!

Tu Jackettio está corriendo en producción en AWS EC2. Ahora puedes:

1. Acceder a `http://TU_IP` (o `https://tudominio.com` si configuraste SSL)
2. Configurar el addon en la interfaz web
3. Agregar el addon a Stremio usando el link generado

---

## 📊 Costos Aproximados AWS

### Free Tier (12 meses gratis):
- **t2.micro**: Gratis durante 12 meses (750 horas/mes)
- **20 GB de almacenamiento**: Gratis
- **1 TB de transferencia**: Gratis (15 GB salida)

### Después del Free Tier:
- **t3.small**: ~$15/mes
- **t3.medium**: ~$30/mes
- **20 GB almacenamiento**: ~$2/mes
- **IP Elástica**: Gratis si está asociada, $0.005/hora si no

**💡 Consejo**: Usa AWS Budget Alerts para recibir notificaciones si superas $5/mes.

---

## 🔒 Mejores Prácticas de Seguridad

1. ✅ Cambia SSH a un puerto no estándar
2. ✅ Usa SSH key authentication (nunca passwords)
3. ✅ Configura fail2ban para bloquear ataques de fuerza bruta
4. ✅ Actualiza el sistema regularmente: `sudo apt update && sudo apt upgrade`
5. ✅ Usa HTTPS siempre (Let's Encrypt es gratis)
6. ✅ Configura backups automáticos con AWS Snapshots
7. ✅ Nunca compartas tus API keys o archivos `.env`

---

## 📞 Soporte

Si tienes problemas:
1. Revisa los logs: `pm2 logs jackettio`
2. Consulta la documentación oficial de Jackettio
3. Revisa el GitHub del proyecto

---

**¡Disfruta tu Jackettio en AWS! 🎬🍿**
