# Jackettio - Stremio Addon

## Descripción del Proyecto

Jackettio es un addon self-hosted para Stremio que resuelve streams usando Jackett y servicios Debrid (Real-Debrid, AllDebrid, Debrid-Link, Premiumize). Permite integrar trackers privados y públicos directamente en Stremio.

## Estado Actual

- **Versión**: 1.7.0
- **Fecha de instalación**: 19 de noviembre de 2025
- **Entorno**: Node.js 20
- **Puerto**: 5000 (configurado para Replit)

## Características Principales

- Resolución de streams usando Jackett y Debrid
- Soporte para trackers públicos y privados
- Priorización de packs de TV
- Sistema de ordenamiento y filtrado
- Filtros de calidad
- Exclusión de keywords
- Caché de búsquedas y peticiones para mejor rendimiento
- Preparación automática del siguiente episodio

## Configuración

### Variables de Entorno Requeridas

Para que Jackettio funcione correctamente, necesitas configurar las siguientes variables de entorno:

1. **JACKETT_URL**: URL de tu instancia de Jackett (ejemplo: `http://localhost:9117`)
2. **JACKETT_API_KEY**: Tu clave API de Jackett (se encuentra en el dashboard de Jackett)

### Variables de Entorno Opcionales

- `PORT`: Puerto del servidor (por defecto: 5000 en Replit)
- `TMDB_ACCESS_TOKEN`: Token de acceso a TMDB para usar en lugar de Cinemeta
- `DATA_FOLDER`: Carpeta para base de datos de caché y archivos torrent
- `ADDON_ID`: ID personalizado del addon
- `ADDON_NAME`: Nombre personalizado del addon
- Y muchas más opciones de configuración disponibles en `src/lib/config.js`

## Estructura del Proyecto

```
/
├── src/                    # Código fuente
│   ├── lib/               # Librerías principales
│   │   ├── debrid/        # Servicios Debrid (RealDebrid, AllDebrid, etc.)
│   │   ├── meta/          # Servicios de metadata (Cinemeta, TMDB)
│   │   └── ...            # Otros módulos
│   ├── static/            # Archivos estáticos (CSS, JS, imágenes)
│   ├── template/          # Plantillas HTML
│   └── index.js           # Punto de entrada
├── package.json           # Dependencias del proyecto
└── replit.md             # Este archivo
```

## Uso

1. Configura las variables de entorno necesarias (JACKETT_URL y JACKETT_API_KEY)
2. Accede a la aplicación usando la URL de Replit
3. Configura el addon en Stremio usando la página de configuración
4. Instala el addon en Stremio usando el link generado

### Nota sobre Docker vs. Workflow

- El workflow de Replit ejecuta la aplicación directamente con `PORT=5000 npm start`
- Si usas Docker, el Dockerfile está configurado para exponer el puerto 5000
- Ambos métodos son compatibles con la configuración del puerto 5000

## Requisitos Previos

- Una instancia de Jackett funcionando
- API Key de Jackett
- (Opcional) Cuenta en algún servicio Debrid (Real-Debrid, AllDebrid, etc.)
- Trackers configurados en Jackett

## Tecnologías Utilizadas

- Node.js con Express
- SQLite para caché
- Localtunnel (opcional)
- Cache Manager
- XML2JS para parseo de respuestas de Jackett

## Notas Importantes

- La aplicación usa un sistema de caché para mejorar el rendimiento
- Los datos de caché se almacenan en `/tmp` por defecto
- El sistema incluye rate limiting para proteger contra abuso
- Hay monitoreo de indexers lentos que se desactivan automáticamente

## Próximos Pasos

1. Configurar las credenciales de Jackett
2. Configurar servicios Debrid (opcional)
3. Personalizar las opciones del addon según preferencias

## Despliegue en AWS EC2

Este proyecto incluye archivos de configuración completos para desplegar en AWS EC2:

### Archivos de Deployment Incluidos

- **`ecosystem.config.js`** - Configuración de PM2 para gestión de procesos en producción
- **`nginx.conf`** - Configuración de Nginx como proxy reverso
- **`.env.example`** - Plantilla completa de variables de entorno
- **`deploy.sh`** - Script automatizado de instalación para EC2
- **`AWS_DEPLOYMENT.md`** - Guía completa paso a paso en español

### Inicio Rápido para AWS

```bash
# 1. En EC2 (después de clonar el repo)
chmod +x deploy.sh
./deploy.sh

# 2. Configurar variables de entorno
nano .env

# 3. ¡Listo! La app estará corriendo en http://TU_IP_EC2
```

Ver `AWS_DEPLOYMENT.md` para la guía completa con:
- Creación de instancia EC2
- Configuración de Security Groups
- Instalación de Jackett
- Configuración de SSL/HTTPS
- Troubleshooting

## Cambios Recientes

- **22 Nov 2025**:
  - ✅ Añadidos archivos de configuración para deployment en AWS EC2
  - Script de instalación automatizado (`deploy.sh`)
  - Configuración de PM2 para gestión de procesos
  - Configuración de Nginx optimizada
  - Guía completa de despliegue en AWS (`AWS_DEPLOYMENT.md`)
  - Actualizado `.gitignore` para excluir archivos sensibles
  
- **20 Nov 2025**:
  - ✅ Corregida integración completa con TorrServer
  - Endpoint correcto: `/torrent/upload` con FormData multipart
  - Campo correcto para archivo torrent: `file`
  - Lógica de streaming corregida: TorrServer no requiere descarga completa
  - Implementación validada contra código fuente oficial de TorrServer
  - Los torrents ahora se procesan correctamente y generan URLs de streaming
  
- **19 Nov 2025**: 
  - Instalación inicial de Jackettio v1.7.0 en Replit
  - Interfaz traducida completamente al español
  - Agregado soporte para TorrServer como proveedor de streaming
  - Corregida URL pública para instalación correcta en Stremio
  - Agregada opción para copiar URL del addon manualmente
