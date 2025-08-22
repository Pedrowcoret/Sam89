const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const db = require('../config/database');
const authMiddleware = require('../middlewares/authMiddleware');
const SSHManager = require('../config/SSHManager');
const wowzaService = require('../config/WowzaStreamingService');
const VideoURLBuilder = require('../config/VideoURLBuilder');
const { spawn } = require('child_process');

const router = express.Router();
// GET /api/videos/view-url - Construir URL de visualização
router.get('/view-url', authMiddleware, async (req, res) => {
  try {
    const { path, video_id } = req.query;
    const userId = req.user.id;
    const userLogin = req.user.email?.split('@')[0] || `user_${userId}`;

    let viewUrl = null;

    if (video_id) {
      // Construir URL baseada no ID do vídeo
      viewUrl = await VideoURLBuilder.buildVideoUrlFromDatabase(video_id, userId);
    } else if (path) {
      // Construir URL baseada no caminho
      viewUrl = await VideoURLBuilder.buildVideoUrlFromPath(path, userLogin);
    }

    if (viewUrl) {
      res.json({
        success: true,
        view_url: viewUrl,
        redirect: true
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Não foi possível construir URL de visualização'
      });
    }
  } catch (error) {
    console.error('Erro ao construir URL de visualização:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor'
    });
  }
});

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const tempDir = '/tmp/video-uploads';
      await fs.mkdir(tempDir, { recursive: true });
      cb(null, tempDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const sanitizedName = file.originalname
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/_{2,}/g, '_');
    cb(null, `${Date.now()}_${sanitizedName}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    // Lista expandida de tipos MIME para vídeos
    const allowedTypes = [
      'video/mp4', 'video/avi', 'video/quicktime', 'video/x-msvideo',
      'video/wmv', 'video/x-ms-wmv', 'video/flv', 'video/x-flv',
      'video/webm', 'video/mkv', 'video/x-matroska', 'video/3gpp',
      'video/3gpp2', 'video/mp2t', 'video/mpeg', 'video/ogg',
      'application/octet-stream' // Para arquivos que podem não ter MIME correto
    ];

    // Verificar também por extensão para todos os formatos
    const fileName = file.originalname.toLowerCase();
    const hasValidExtension = [
      '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv',
      '.3gp', '.3g2', '.ts', '.mpg', '.mpeg', '.ogv', '.m4v', '.asf'
    ].some(ext =>
      fileName.endsWith(ext)
    );

    if (allowedTypes.includes(file.mimetype) || hasValidExtension) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de arquivo não suportado: ${file.mimetype}. Extensões aceitas: .mp4, .avi, .mov, .wmv, .flv, .webm, .mkv, .3gp, .ts, .mpg, .ogv, .m4v`), false);
    }
  }
});

// Função para obter informações do vídeo via ffprobe
const getVideoInfo = async (filePath) => {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);

    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code === 0 && stdout) {
        try {
          const info = JSON.parse(stdout);
          resolve(info);
        } catch (parseError) {
          reject(new Error('Erro ao analisar informações do vídeo'));
        }
      } else {
        reject(new Error('Erro ao obter informações do vídeo'));
      }
    });

    ffprobe.on('error', (error) => {
      reject(error);
    });
  });
};

// Função para verificar se codec é compatível
const isCompatibleCodec = (codecName) => {
  const compatibleCodecs = ['h264', 'h265', 'hevc'];
  return compatibleCodecs.includes(codecName?.toLowerCase());
};

// Função para verificar se formato é compatível
const isCompatibleFormat = (formatName, extension) => {
  const compatibleFormats = ['mp4'];
  return compatibleFormats.includes(extension?.toLowerCase()?.replace('.', ''));
};

router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const userLogin = req.user.email ? req.user.email.split('@')[0] : `user_${userId}`;
    const folderId = req.query.folder_id;
    
    if (!folderId) {
      return res.status(400).json({ error: 'folder_id é obrigatório' });
    }

    // Buscar dados da pasta na nova tabela folders
    const [folderRows] = await db.execute(
      'SELECT nome_sanitizado, servidor_id, espaco_usado FROM folders WHERE id = ? AND user_id = ?',
      [folderId, userId]
    );
    
    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folderData = folderRows[0];
    const folderName = folderData.nome_sanitizado;
    const serverId = folderData.servidor_id || 1;
    // Buscar vídeos na tabela videos
    const [rows] = await db.execute(
      `SELECT 
        id,
        nome,
        url,
        caminho,
        duracao,
        tamanho_arquivo as tamanho,
        bitrate_video,
        formato_original,
        codec_video,
        is_mp4,
        compativel,
        largura,
        altura
       FROM videos 
       WHERE codigo_cliente = ? AND pasta = ?
       ORDER BY id DESC`,
      [userId, folderId]
    );

    console.log(`📁 Buscando vídeos na pasta: ${folderName} (ID: ${folderId})`);
    console.log(`📊 Encontrados ${rows.length} vídeos no banco para pasta ${folderName}`);

    const videos = rows.map(video => {
      // Construir URL correta baseada no caminho
      let url = video.url || video.caminho;
      
      // Construir URL baseada na estrutura do servidor
      if (!url) {
        // Se não tem URL, construir baseado no nome do arquivo
        url = `streaming/${userLogin}/${folderName}/${video.nome}`;
      } else {
        // Limpar URL existente
        if (url.startsWith('/home/streaming/')) {
          url = url.replace('/home/streaming/', 'streaming/');
        } else if (url.startsWith('/content/')) {
          url = url.replace('/content/', '');
        } else if (url.startsWith('streaming/')) {
          // Já está no formato correto
        }
        
        // Garantir formato correto: usuario/pasta/arquivo
        if (!url.includes('/')) {
          url = `streaming/${userLogin}/${folderName}/${url}`;
        } else if (!url.startsWith('streaming/')) {
          url = `streaming/${url}`;
        }
        
        // Remover barra inicial se existir
        if (url.startsWith('/')) {
          url = url.substring(1);
        }
      }

      // Buscar limite de bitrate do usuário
      const userBitrateLimit = req.user.bitrate || 2500;

      // Verificar se bitrate excede o limite
      const currentBitrate = video.bitrate_video || 0;
      const bitrateExceedsLimit = currentBitrate > userBitrateLimit;
      
      // Verificar compatibilidade de formato e codec
      const fileExtension = path.extname(video.nome).toLowerCase();
      const isMP4 = video.is_mp4 === 1;
      const codecCompatible = isCompatibleCodec(video.codec_video) || video.codec_video === 'h264';
      
      // Lógica de compatibilidade atualizada
      let needsConversion = false;
      let compatibilityStatus = 'compatible';
      let compatibilityMessage = 'Otimizado';
      
      // Se não é MP4 ou codec não é H264/H265, precisa conversão
      if (!isMP4 || !codecCompatible) {
        needsConversion = true;
        compatibilityStatus = 'needs_conversion';
        compatibilityMessage = 'Necessário Conversão';
      }
      // Se bitrate excede limite, precisa conversão
      else if (bitrateExceedsLimit) {
        needsConversion = true;
        compatibilityStatus = 'needs_conversion';
        compatibilityMessage = 'Necessário Conversão';
      }
      // Se é MP4 com H264/H265 e dentro do limite, está otimizado
      else if (isMP4 && codecCompatible && !bitrateExceedsLimit) {
        needsConversion = false;
        compatibilityStatus = 'compatible';
        compatibilityMessage = 'Otimizado';
      }
      
      // Verificar campo compativel do banco para casos especiais
      if (video.compativel === 'otimizado') {
        compatibilityStatus = 'compatible';
        compatibilityMessage = 'Otimizado';
        needsConversion = false;
      } else if (video.compativel === 'nao') {
        compatibilityStatus = 'needs_conversion';
        compatibilityMessage = 'Necessário Conversão';
        needsConversion = true;
      }
      
      return {
        id: video.id,
        nome: video.nome,
        url,
        duracao: video.duracao,
        tamanho: video.tamanho,
        bitrate_video: video.bitrate_video,
        formato_original: video.formato_original,
        codec_video: video.codec_video,
        is_mp4: video.is_mp4,
        compativel: video.compativel,
        largura: video.largura,
        altura: video.altura,
        folder: folderName,
        user: userLogin,
        user_bitrate_limit: userBitrateLimit,
        bitrate_exceeds_limit: bitrateExceedsLimit,
        needs_conversion: needsConversion,
        compatibility_status: compatibilityStatus,
        compatibility_message: compatibilityMessage,
        codec_compatible: codecCompatible,
        has_converted_version: video.has_converted_version === 1
      };
    });

    res.json(videos);
  } catch (err) {
    console.error('Erro ao buscar vídeos:', err);
    res.status(500).json({ error: 'Erro ao buscar vídeos', details: err.message });
  }
});

router.post('/upload', authMiddleware, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const userId = req.user.id;
    const userLogin = req.user.usuario || (req.user.email ? req.user.email.split('@')[0] : `user_${userId}`);
    const folderId = req.query.folder_id || 'default';

    console.log(`📤 Upload iniciado - Usuário: ${userLogin}, Pasta: ${folderId}, Arquivo: ${req.file.originalname}`);
    console.log(`📋 Tipo MIME: ${req.file.mimetype}, Tamanho: ${req.file.size} bytes`);

    // Verificar se é um formato de vídeo válido
    const videoExtensions = [
      '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv',
      '.3gp', '.3g2', '.ts', '.mpg', '.mpeg', '.ogv', '.m4v', '.asf'
    ];
    const fileExtension = path.extname(req.file.originalname).toLowerCase();

    if (!videoExtensions.includes(fileExtension)) {
      console.log(`❌ Extensão não suportada: ${fileExtension}`);
      await fs.unlink(req.file.path).catch(() => { });
      return res.status(400).json({
        error: `Formato de arquivo não suportado: ${fileExtension}`,
        details: `Formatos aceitos: ${videoExtensions.join(', ')}`
      });
    }

    // Obter informações reais do vídeo usando ffprobe
    let videoInfo = null;
    let duracao = 0;
    let bitrateVideo = 0;
    let codecVideo = 'unknown';
    let largura = 0;
    let altura = 0;
    let formatoOriginal = fileExtension.substring(1);
    
    try {
      console.log(`🔍 Analisando vídeo: ${req.file.path}`);
      videoInfo = await getVideoInfo(req.file.path);
      
      if (videoInfo.format) {
        duracao = Math.floor(parseFloat(videoInfo.format.duration) || 0);
        bitrateVideo = Math.floor(parseInt(videoInfo.format.bit_rate) / 1000) || 0; // Converter para kbps
        formatoOriginal = videoInfo.format.format_name || fileExtension.substring(1);
      }
      
      if (videoInfo.streams) {
        const videoStream = videoInfo.streams.find(s => s.codec_type === 'video');
        if (videoStream) {
          codecVideo = videoStream.codec_name || 'unknown';
          largura = videoStream.width || 0;
          altura = videoStream.height || 0;
          
          // Se não conseguiu bitrate do format, tentar do stream
          if (!bitrateVideo && videoStream.bit_rate) {
            bitrateVideo = Math.floor(parseInt(videoStream.bit_rate) / 1000) || 0;
          }
        }
      }
      
      console.log(`📊 Informações do vídeo:`, {
        duracao,
        bitrateVideo,
        codecVideo,
        largura,
        altura,
        formatoOriginal
      });
    } catch (probeError) {
      console.warn('⚠️ Não foi possível analisar o vídeo com ffprobe:', probeError.message);
      // Continuar com valores padrão
    }
    
    const tamanho = req.file.size;

    const [userRows] = await db.execute(
      `SELECT 
        f.servidor_id, f.nome_sanitizado as folder_name,
        u.espaco, f.espaco_usado
       FROM folders f
       LEFT JOIN streamings u ON f.user_id = u.codigo_cliente
       WHERE f.id = ? AND f.user_id = ?`,
      [folderId, userId]
    );
    if (userRows.length === 0) {
      console.log(`❌ Pasta ${folderId} não encontrada para usuário ${userId}`);
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const userData = userRows[0];
    const serverId = userData.servidor_id || 1;
    const folderName = userData.folder_name;

    console.log(`📁 Pasta encontrada: ${folderName}, Servidor: ${serverId}`);

    const spaceMB = Math.ceil(tamanho / (1024 * 1024));
    const availableSpace = userData.espaco - (userData.espaco_usado || 0);

    if (spaceMB > availableSpace) {
      console.log(`❌ Espaço insuficiente: ${spaceMB}MB necessário, ${availableSpace}MB disponível`);
      await fs.unlink(req.file.path).catch(() => { });
      return res.status(400).json({
        error: `Espaço insuficiente. Necessário: ${spaceMB}MB, Disponível: ${availableSpace}MB`,
        details: `Seu plano permite ${userData.espaco}MB de armazenamento. Atualmente você está usando ${userData.espaco_usado || 0}MB. Para enviar este arquivo, você precisa de mais ${spaceMB - availableSpace}MB livres.`,
        spaceInfo: {
          required: spaceMB,
          available: availableSpace,
          total: userData.espaco,
          used: userData.espaco_usado || 0,
          percentage: Math.round(((userData.espaco_usado || 0) / userData.espaco) * 100)
        }
      });
    }

    try {
      // Garantir que estrutura completa do usuário existe
      await SSHManager.createCompleteUserStructure(serverId, userLogin, {
        bitrate: req.user.bitrate || 2500,
        espectadores: req.user.espectadores || 100,
        status_gravando: 'nao'
      });
      await SSHManager.createUserFolder(serverId, userLogin, folderName);

      // Estrutura correta: /home/streaming/[usuario]/[pasta]/arquivo
      const remotePath = `/home/streaming/${userLogin}/${folderName}/${req.file.filename}`;
      await SSHManager.uploadFile(serverId, req.file.path, remotePath);
      await fs.unlink(req.file.path);

      console.log(`✅ Arquivo enviado para: ${remotePath}`);
      console.log(`📂 Estrutura: /home/streaming/${userLogin}/${folderName}/${req.file.filename}`);

      // Construir caminho relativo para salvar no banco
      const relativePath = `streaming/${userLogin}/${folderName}/${req.file.filename}`;
      console.log(`💾 Salvando no banco com path: ${relativePath}`);
      
      // Construir URL de visualização usando novo sistema
      const viewUrl = await VideoURLBuilder.buildVideoViewUrl(userLogin, folderName, req.file.filename, serverId);

      // Nome do vídeo para salvar no banco
      const videoTitle = req.file.originalname;

      // Verificar compatibilidade
      const isMP4 = fileExtension === '.mp4';
      const codecCompatible = isCompatibleCodec(codecVideo);
      const bitrateExceedsLimit = bitrateVideo > (req.user.bitrate || 2500);
      
      // Lógica de compatibilidade atualizada
      let needsConversion = false;
      let compatibilityStatus = 'sim';
      
      // Se não é MP4 ou codec não é H264/H265, precisa conversão
      if (!isMP4 || !codecCompatible) {
        needsConversion = true;
        compatibilityStatus = 'nao';
      }
      // Se bitrate excede limite, precisa conversão
      else if (bitrateExceedsLimit) {
        needsConversion = true;
        compatibilityStatus = 'nao';
      }
      // Se é MP4 com H264/H265 e dentro do limite, está otimizado
      else if (isMP4 && codecCompatible && !bitrateExceedsLimit) {
        needsConversion = false;
        compatibilityStatus = 'otimizado';
      }
      

      // Salvar na tabela videos SEM conversão automática
      const [result] = await db.execute(
        `INSERT INTO videos (
          nome, descricao, url, caminho, duracao, tamanho_arquivo,
          codigo_cliente, pasta, bitrate_video, formato_original, codec_video,
          largura, altura, is_mp4, compativel
        ) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          videoTitle,
          relativePath,
          remotePath,
          duracao,
          tamanho,
          userId,
          folderId,
          bitrateVideo,
          formatoOriginal,
          codecVideo,
          largura,
          altura,
          isMP4 ? 1 : 0,
          compatibilityStatus
        ]
      );

      // Atualizar espaço usado na pasta
      await db.execute(
        'UPDATE folders SET espaco_usado = espaco_usado + ? WHERE id = ?',
        [spaceMB, folderId]
      );

      console.log(`✅ Vídeo salvo no banco com ID: ${result.insertId}`);

      // Atualizar arquivo SMIL do usuário após upload
      try {
        const PlaylistSMILService = require('../services/PlaylistSMILService');
        await PlaylistSMILService.updateUserSMIL(userId, userLogin, serverId);
      } catch (smilError) {
        console.warn('Erro ao atualizar arquivo SMIL:', smilError.message);
      }

      // Determinar status de compatibilidade para resposta
      let statusMessage = 'Otimizado';
      let statusColor = 'green';
      
      if (needsConversion) {
        statusMessage = 'Necessário Conversão';
        statusColor = 'red';
      } else if (compatibilityStatus === 'otimizado') {
        statusMessage = 'Otimizado';
        statusColor = 'green';
      }

      res.status(201).json({
        id: result.insertId,
        nome: videoTitle,
        url: relativePath,
        view_url: viewUrl,
        path: remotePath,
        originalFile: remotePath,
        bitrate_video: bitrateVideo,
        codec_video: codecVideo,
        formato_original: fileExtension.substring(1),
        largura: largura,
        altura: altura,
        is_mp4: fileExtension === '.mp4',
        needs_conversion: needsConversion,
        compatibility_status: statusMessage,
        compatibility_color: statusColor,
        duracao,
        tamanho,
        space_used_mb: spaceMB
      });
    } catch (uploadError) {
      console.error('Erro durante upload:', uploadError);
      await fs.unlink(req.file.path).catch(() => { });
      throw uploadError;
    }
  } catch (err) {
    console.error('Erro no upload:', err);
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => { });
    }
    res.status(500).json({ error: 'Erro no upload do vídeo', details: err.message });
  }
});

// Função auxiliar para formatar duração
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Rota para testar acesso a vídeos
router.get('/test/:userId/:folder/:filename', authMiddleware, async (req, res) => {
  try {
    const { userId, folder, filename } = req.params;

    // Verificar se arquivo existe no servidor via SSH
    const [serverRows] = await db.execute(
      'SELECT codigo_servidor FROM streamings WHERE codigo_cliente = ? LIMIT 1',
      [userId]
    );

    const serverId = serverRows.length > 0 ? serverRows[0].codigo_servidor : 1;
    const remotePath = `/home/streaming/${userLogin}/${folder}/${filename}`;

    try {
      const fileInfo = await SSHManager.getFileInfo(serverId, remotePath);

      if (fileInfo.exists) {
        res.json({
          success: true,
          exists: true,
          path: remotePath,
          info: fileInfo,
          url: `/content/streaming/${userLogin}/${folder}/${filename}`
        });
      } else {
        res.json({
          success: false,
          url: `/content/streaming/${userLogin}/${folder}/${filename}`,
          error: 'Arquivo não encontrado no servidor'
        });
      }
    } catch (sshError) {
      res.status(500).json({
        success: false,
        error: 'Erro ao verificar arquivo no servidor',
        details: sshError.message
      });
    }
  } catch (err) {
    console.error('Erro no teste de vídeo:', err);
    res.status(500).json({ error: 'Erro no teste de vídeo', details: err.message });
  }
});

// Rota para servir vídeos via proxy do Wowza
router.get('/content/*', authMiddleware, async (req, res) => {
  try {
    const requestPath = req.params[0];
    console.log(`🎥 Solicitação de vídeo: ${requestPath}`);
    
    // Verificar se é um arquivo de vídeo ou playlist
    const isVideoFile = /\.(mp4|avi|mov|wmv|flv|webm|mkv)$/i.test(requestPath);
    const isStreamFile = /\.(m3u8|ts)$/i.test(requestPath);
    
    if (!isVideoFile && !isStreamFile) {
      console.log(`❌ Tipo de arquivo não suportado: ${requestPath}`);
        // Criar apenas a pasta específica (estrutura do usuário já deve existir)
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Accept-Ranges', 'bytes');
    
    // Definir Content-Type baseado na extensão
    if (isStreamFile && requestPath.includes('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (isStreamFile && requestPath.includes('.ts')) {
    } else if (requestPath.includes('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
    } else if (requestPath.includes('.avi')) {
    } else if (requestPath.includes('.mov')) {
      res.setHeader('Content-Type', 'video/quicktime');
    } else if (requestPath.includes('.wmv')) {
      res.setHeader('Content-Type', 'video/x-ms-wmv');
    } else if (requestPath.includes('.webm')) {
      res.setHeader('Content-Type', 'video/webm');
    } else if (requestPath.includes('.mkv')) {
      res.setHeader('Content-Type', 'video/x-matroska');
    } else {
      res.setHeader('Content-Type', 'video/mp4');
    }
    
    // Cache diferente para streams vs arquivos
    if (isStreamFile) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
    
    // Limpar e processar caminho
    const cleanPath = requestPath.replace('/content/', '').replace(/^\/+/, '');
    
    const pathParts = cleanPath.split('/');
    
    // Estrutura: usuario/pasta/arquivo
    if (pathParts.length < 3) {
      console.log(`❌ Caminho inválido: ${requestPath}`);
      return res.status(404).json({ error: 'Caminho de vídeo inválido' });
    }
    
    const userLogin = pathParts[0];
    const folderName = pathParts[1];
    const fileName = pathParts[2];
    
    // Buscar servidor do usuário dinamicamente
    let wowzaHost = '51.222.156.223'; // Fallback padrão
    let wowzaPort = 6980;
    let wowzaUser = 'admin';
    let wowzaPassword = 'FK38Ca2SuE6jvJXed97VMn';
    
    try {
      // Buscar servidor baseado no usuário logado
      const [userServerRows] = await db.execute(
        'SELECT codigo_servidor FROM streamings WHERE codigo_cliente = ? OR usuario = ? LIMIT 1',
        [req.user.userId, userLogin]
      );
      
      if (userServerRows.length > 0) {
        const serverId = userServerRows[0].codigo_servidor;
        
        // Buscar dados do servidor
        const [serverRows] = await db.execute(
          'SELECT ip, dominio, senha_root FROM wowza_servers WHERE codigo = ? AND status = "ativo"',
          [serverId]
        );
        
        if (serverRows.length > 0) {
          const server = serverRows[0];
          wowzaHost = server.dominio || server.ip; // Priorizar domínio
          wowzaPassword = server.senha_root || wowzaPassword;
          console.log(`✅ Usando servidor dinâmico: ${wowzaHost} (Servidor ID: ${serverId})`);
        } else {
          console.log(`⚠️ Servidor ${serverId} não encontrado, usando padrão`);
        }
      } else {
        console.log(`⚠️ Servidor do usuário ${userLogin} não encontrado, usando padrão`);
      }
    } catch (serverError) {
      console.warn('Erro ao buscar servidor do usuário, usando padrão:', serverError.message);
    }
    
    // Processar nome do arquivo
    const fileExtension = path.extname(fileName).toLowerCase();
    const finalFileName = fileName.endsWith('.mp4') ? fileName : fileName.replace(/\.[^/.]+$/, '.mp4');
    
    // Configurar URL do Wowza dinâmico
    const fetch = require('node-fetch');
    
    let wowzaUrl;
    if (isStreamFile) {
      // Para streams HLS - verificar se arquivo MP4 existe, senão usar original
      wowzaUrl = `http://${wowzaHost}:1935/vod/_definst_/mp4:${userLogin}/${folderName}/${finalFileName}/playlist.m3u8`;
    } else {
      // Para arquivos diretos - tentar MP4 primeiro
      wowzaUrl = `http://${wowzaUser}:${wowzaPassword}@${wowzaHost}:${wowzaPort}/content/${userLogin}/${folderName}/${finalFileName}`;
    }
    
    console.log(`🔗 Redirecionando para Wowza dinâmico (${wowzaHost}): ${wowzaUrl}`);
    
    try {
      const requestHeaders = {
        'Range': req.headers.range || '',
        'User-Agent': 'Streaming-System/1.0',
        // Atualizar arquivo SMIL de forma assíncrona (não bloquear resposta)
        setImmediate(async () => {
          try {
            const PlaylistSMILService = require('../services/PlaylistSMILService');
            await PlaylistSMILService.updateUserSMIL(userId, userLogin, serverId);
          } catch (smilError) {
            console.warn('Erro ao atualizar arquivo SMIL:', smilError.message);
          }
        });
        headers: requestHeaders,
        timeout: 30000 // Timeout aumentado para melhor estabilidade
      });
      
      if (!wowzaResponse.ok) {
        console.log(`❌ Erro ao acessar vídeo no Wowza (${wowzaResponse.status}): ${wowzaUrl}`);
        
        // Se falhou com MP4, tentar com arquivo original
        if (finalFileName !== fileName) {
          console.log(`🔄 Tentando arquivo original: ${fileName}`);
          const originalUrl = isStreamFile ? 
          // Sincronização removida para evitar spam de requisições
          console.log(`📁 Carregando vídeos da pasta ${selectedFolder} (sem sincronização automática)`);
          
          if (originalResponse.ok) {
            console.log(`✅ Servindo arquivo original do Wowza: ${originalUrl}`);
            originalResponse.headers.forEach((value, key) => {
              if (!res.headersSent) {
                res.setHeader(key, value);
              }
            });
            return originalResponse.body.pipe(res);
          }
        }
        
        return res.status(404).json({ 
          error: 'Vídeo não encontrado',
          details: 'O arquivo não foi encontrado no servidor Wowza',
          attempted_paths: [
            `${userLogin}/${folderName}/${finalFileName}`,
            finalFileName !== fileName ? `${userLogin}/${folderName}/${fileName}` : null
          ].filter(Boolean)
        });
      }
      
      // Repassar headers do Wowza
      wowzaResponse.headers.forEach((value, key) => {
        if (!res.headersSent) {
          res.setHeader(key, value);
        }
      });
      
      console.log(`✅ Servindo vídeo do Wowza: ${wowzaUrl}`);
      
      // Pipe da resposta do Wowza para o cliente
      wowzaResponse.body.pipe(res);
      
    } catch (fetchError) {
      console.error('Erro ao conectar com Wowza:', fetchError);
      return res.status(503).json({ 
        error: 'Servidor de vídeo temporariamente indisponível',
        details: 'Não foi possível conectar ao servidor de streaming'
      });
    }
    
  } catch (err) {
    console.error('Erro no proxy de vídeo:', err);
    res.status(500).json({ error: 'Erro interno do servidor', details: err.message });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const videoId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.usuario || `user_${userId}`;

    // Buscar dados do vídeo
    const [videoRows] = await db.execute(
      'SELECT caminho, nome, tamanho_arquivo, pasta FROM videos WHERE id = ? AND (codigo_cliente = ? OR codigo_cliente IN (SELECT codigo FROM streamings WHERE codigo_cliente = ?))',
      [videoId, userId, userId]
    );
    if (videoRows.length === 0) {
      return res.status(404).json({ error: 'Vídeo não encontrado' });
    }

    const { caminho, tamanho_arquivo, pasta } = videoRows[0];

    if (!caminho.includes(`/${userLogin}/`)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    // Buscar servidor para execução via SSH
    const [serverRows] = await db.execute(
      'SELECT servidor_id FROM folders WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const serverId = serverRows.length > 0 ? serverRows[0].servidor_id : 1;

    let fileSize = tamanho_arquivo || 0;
    // Estrutura correta: verificar se já está no formato correto
    const remotePath = caminho.startsWith('/home/streaming') ? 
      caminho : `/home/streaming/${caminho}`;

    // Verificar tamanho real do arquivo via SSH, se necessário
    if (!fileSize) {
      try {
        const fileInfo = await SSHManager.getFileInfo(serverId, remotePath);
        fileSize = fileInfo.exists ? fileInfo.size : 0;
      } catch (err) {
        console.warn('Não foi possível verificar tamanho do arquivo via SSH:', err.message);
      }
    }

    // Remover arquivo via SSH
    try {
      await SSHManager.deleteFile(serverId, remotePath);
      console.log(`✅ Arquivo remoto removido: ${remotePath}`);
      
      // Atualizar arquivo SMIL do usuário após remoção
      try {
        const PlaylistSMILService = require('../services/PlaylistSMILService');
        await PlaylistSMILService.updateUserSMIL(userId, userLogin, serverId);
      } catch (smilError) {
        console.warn('Erro ao atualizar arquivo SMIL:', smilError.message);
      }
    } catch (err) {
      console.warn('Erro ao deletar arquivo remoto:', err.message);
    }

    // Remover vídeo da tabela videos
    await db.execute('DELETE FROM videos WHERE id = ?', [videoId]);
    
    // Calcular espaço liberado
    const spaceMB = Math.ceil((fileSize) / (1024 * 1024));
    
    // Atualizar espaço usado na pasta específica
    await db.execute(
      'UPDATE folders SET espaco_usado = GREATEST(espaco_usado - ?, 0) WHERE id = ?',
      [spaceMB, pasta]
    );
    
    console.log(`📊 Espaço liberado: ${spaceMB}MB`);

    return res.json({ success: true, message: 'Vídeo removido com sucesso' });
  } catch (err) {
    console.error('Erro ao remover vídeo:', err);
    return res.status(500).json({ error: 'Erro ao remover vídeo', details: err.message });
  }
});

module.exports = router;