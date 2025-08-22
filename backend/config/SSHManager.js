const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

class SSHManager {
    constructor() {
        this.connections = new Map();
        this.lastErrorLogged = 0; // Para evitar spam de logs
    }

    async getConnection(serverId) {
        try {
            // Buscar dados do servidor no banco
            const db = require('./database');
            const [serverRows] = await db.execute(
                'SELECT ip, porta_ssh, senha_root FROM wowza_servers WHERE codigo = ? AND status = "ativo"',
                [serverId]
            );

            if (serverRows.length === 0) {
                throw new Error('Servidor não encontrado ou inativo');
            }

            const server = serverRows[0];
            const connectionKey = `${server.ip}:${server.porta_ssh}`;

            // Verificar se já existe conexão ativa
            if (this.connections.has(connectionKey)) {
                const existingConn = this.connections.get(connectionKey);
                if (existingConn.conn && existingConn.conn._sock && !existingConn.conn._sock.destroyed) {
                    return existingConn;
                }
                // Remover conexão inválida
                this.connections.delete(connectionKey);
            }

            // Criar nova conexão SSH
            const conn = new Client();
            
            return new Promise((resolve, reject) => {
                conn.on('ready', () => {
                    console.log(`✅ Conectado via SSH ao servidor ${server.ip}`);
                    
                    const connectionData = {
                        conn,
                        server,
                        connected: true,
                        lastUsed: new Date()
                    };
                    
                    this.connections.set(connectionKey, connectionData);
                    resolve(connectionData);
                });

                conn.on('error', (err) => {
                    console.error(`❌ Erro SSH para ${server.ip}:`, err);
                    reject(err);
                });

                conn.on('close', () => {
                    console.log(`🔌 Conexão SSH fechada para ${server.ip}`);
                    this.connections.delete(connectionKey);
                });

                // Conectar
                conn.connect({
                    host: server.ip,
                    port: server.porta_ssh || 22,
                    username: 'root',
                    password: server.senha_root,
                    readyTimeout: 30000,
                    keepaliveInterval: 30000
                });
            });

        } catch (error) {
            console.error('Erro ao obter conexão SSH:', error);
            throw error;
        }
    }

    async executeCommand(serverId, command) {
        try {
            const { conn } = await this.getConnection(serverId);
            
            return new Promise((resolve, reject) => {
                conn.exec(command, (err, stream) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    let stdout = '';
                    let stderr = '';

                    stream.on('close', (code, signal) => {
                        if (code === 0) {
                            resolve({ success: true, stdout, stderr, code });
                        } else {
                            reject(new Error(`Comando falhou com código ${code}: ${stderr}`));
                        }
                    });

                    stream.on('data', (data) => {
                        stdout += data.toString();
                    });

                    stream.stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
                });
            });
        } catch (error) {
            console.error('Erro ao executar comando SSH:', error);
            throw error;
        }
    }

    async uploadFile(serverId, localPath, remotePath) {
        try {
            const { conn } = await this.getConnection(serverId);
            
            return new Promise((resolve, reject) => {
                conn.sftp((err, sftp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    // Criar diretório remoto se não existir
                    const remoteDir = path.dirname(remotePath);
                    sftp.mkdir(remoteDir, { mode: 0o755 }, (mkdirErr) => {
                        // Ignorar erro se diretório já existir
                        
                        sftp.fastPut(localPath, remotePath, (uploadErr) => {
                            if (uploadErr) {
                                reject(uploadErr);
                                return;
                            }

                            // Definir permissões do arquivo
                            sftp.chmod(remotePath, 0o644, (chmodErr) => {
                                if (chmodErr) {
                                    console.warn('Aviso: Não foi possível definir permissões:', chmodErr);
                                }
                                
                                resolve({ success: true, remotePath });
                            });
                        });
                    });
                });
            });
        } catch (error) {
            console.error('Erro ao fazer upload via SSH:', error);
            throw error;
        }
    }

    async createUserDirectory(serverId, userLogin) {
        try {
            // Nova estrutura: /home/streaming/[usuario]
            const userDir = `/home/streaming/${userLogin}`;
            const commands = [
                `mkdir -p ${userDir}`,
                `mkdir -p ${userDir}/recordings`,
                `mkdir -p ${userDir}/logos`,
                `chown -R streaming:streaming ${userDir} || true`,
                `chmod -R 755 ${userDir} || true`
            ];

            for (const command of commands) {
                try {
                    const result = await this.executeCommand(serverId, command);
                    console.log(`✅ Comando executado: ${command}`);
                    if (result.stderr) {
                        console.warn(`⚠️ Aviso no comando "${command}": ${result.stderr}`);
                    }
                } catch (cmdError) {
                    console.warn(`⚠️ Erro no comando "${command}": ${cmdError.message}`);
                    // Continuar mesmo com erros de permissão
                }
            }

            console.log(`✅ Diretório criado para usuário ${userLogin} no servidor ${serverId}`);
            
            // Verificar se diretório foi criado
            const checkResult = await this.executeCommand(serverId, `ls -la ${userDir}`);
            console.log(`📁 Conteúdo do diretório ${userDir}:`, checkResult.stdout);
            
            return { success: true, userDir };
        } catch (error) {
            console.error(`Erro ao criar diretório para usuário ${userLogin}:`, error);
            throw error;
        }
    }

    async createUserFolder(serverId, userLogin, folderName) {
        try {
            // Estrutura correta: /home/streaming/[usuario]/[pasta]
            const folderPath = `/home/streaming/${userLogin}/${folderName}`;
            const commands = [
                `mkdir -p ${folderPath}`,
                `chmod 755 ${folderPath}`,
                `chown streaming:streaming ${folderPath} 2>/dev/null || true`
            ];

            for (const command of commands) {
                try {
                    const result = await this.executeCommand(serverId, command);
                    if (result.stderr) {
                        console.warn(`⚠️ Aviso: ${result.stderr}`);
                    }
                } catch (cmdError) {
                    console.warn(`⚠️ Erro: ${cmdError.message}`);
                    // Continuar mesmo com erros de permissão
                }
            }

            // Aguardar um momento para garantir que pasta foi criada
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Verificar se pasta foi criada
            const checkResult = await this.executeCommand(serverId, `test -d "${folderPath}" && echo "EXISTS" || echo "NOT_EXISTS"`);
            
            if (!checkResult.stdout.includes('EXISTS')) {
                throw new Error(`Pasta não foi criada: ${folderPath}`);
            }
            
            console.log(`✅ Pasta ${folderName} criada: ${folderPath}`);
            
            return { success: true, folderPath };
        } catch (error) {
            console.error(`Erro ao criar pasta ${folderName}:`, error);
            throw error;
        }
    }

    // Criar estrutura completa do usuário (streaming + wowza)
    async createCompleteUserStructure(serverId, userLogin, userConfig) {
        try {
            console.log(`🏗️ Criando estrutura completa para usuário: ${userLogin}`);

            // Criar apenas estrutura básica de streaming
            await this.createUserDirectory(serverId, userLogin);

            console.log(`✅ Estrutura completa criada para ${userLogin}`);
            return { success: true };

        } catch (error) {
            console.error(`Erro ao criar estrutura completa para ${userLogin}:`, error);
            throw error;
        }
    }

    // Verificar estrutura completa do usuário
    async checkCompleteUserStructure(serverId, userLogin) {
        try {
            // Verificar estrutura de streaming
            const streamingPath = `/home/streaming/${userLogin}`;
            const streamingExists = await this.checkDirectoryExists(serverId, streamingPath);

            return {
                streaming_directory: streamingExists,
                complete: streamingExists
            };

        } catch (error) {
            console.error(`Erro ao verificar estrutura completa do usuário ${userLogin}:`, error);
            return {
                streaming_directory: false,
                complete: false,
                error: error.message
            };
        }
    }

    async checkDirectoryExists(serverId, path) {
        try {
            const command = `test -d "${path}" && echo "EXISTS" || echo "NOT_EXISTS"`;
            const result = await this.executeCommand(serverId, command);
            return result.stdout.includes('EXISTS');
        } catch (error) {
            console.warn(`Erro ao verificar diretório ${path}:`, error.message);
            return false;
        }
    }

    // Método otimizado para verificar e obter informações de pasta
    async getFolderInfo(serverId, folderPath) {
        try {
            // Comando combinado para verificar existência e obter informações
            const command = `if [ -d "${folderPath}" ]; then echo "EXISTS"; find "${folderPath}" -type f | wc -l; du -sb "${folderPath}" 2>/dev/null | cut -f1 || echo "0"; else echo "NOT_EXISTS"; fi`;
            const result = await this.executeCommand(serverId, command);
            
            const lines = result.stdout.trim().split('\n');
            
            if (lines[0] === 'EXISTS') {
                const fileCount = parseInt(lines[1]) || 0;
                const sizeBytes = parseInt(lines[2]) || 0;
                
                return {
                    exists: true,
                    file_count: fileCount,
                    size_bytes: sizeBytes,
                    size_mb: Math.ceil(sizeBytes / (1024 * 1024)),
                    path: folderPath
                };
            } else {
                return {
                    exists: false,
                    file_count: 0,
                    size_bytes: 0,
                    size_mb: 0,
                    path: folderPath
                };
            }
        } catch (error) {
            console.warn(`Erro ao obter informações da pasta ${folderPath}:`, error.message);
            return {
                exists: false,
                error: error.message,
                path: folderPath
            };
        }
    }

    async deleteFile(serverId, remotePath) {
        try {
            const command = `rm -f "${remotePath}"`;
            await this.executeCommand(serverId, command);
            
            console.log(`✅ Arquivo removido: ${remotePath}`);
            return { success: true };
        } catch (error) {
            console.error(`Erro ao remover arquivo ${remotePath}:`, error);
            throw error;
        }
    }

    async listFiles(serverId, remotePath) {
        try {
            const command = `ls -la "${remotePath}"`;
            const result = await this.executeCommand(serverId, command);
            
            return { success: true, files: result.stdout };
        } catch (error) {
            console.error(`Erro ao listar arquivos em ${remotePath}:`, error);
            throw error;
        }
    }

    async getFileInfo(serverId, remotePath) {
        try {
            const command = `stat "${remotePath}" 2>/dev/null && echo "EXISTS" || echo "NOT_EXISTS"`;
            const result = await this.executeCommand(serverId, command);
            
            if (result.stdout.includes('NOT_EXISTS')) {
                return { exists: false };
            }

            // Se existe, obter informações detalhadas
            const detailsCommand = `ls -la "${remotePath}" 2>/dev/null`;
            const detailsResult = await this.executeCommand(serverId, detailsCommand);
            
            return { 
                exists: true, 
                info: detailsResult.stdout,
                size: this.extractFileSize(detailsResult.stdout),
                permissions: this.extractPermissions(detailsResult.stdout)
            };
        } catch (error) {
            return { exists: false };
        }
    }

    extractFileSize(lsOutput) {
        try {
            const parts = lsOutput.trim().split(/\s+/);
            return parseInt(parts[4]) || 0;
        } catch (error) {
            return 0;
        }
    }

    extractPermissions(lsOutput) {
        try {
            const parts = lsOutput.trim().split(/\s+/);
            return parts[0] || '';
        } catch (error) {
            return '';
        }
    }

    closeConnection(serverId) {
        try {
            const db = require('./database');
            db.execute('SELECT ip, porta_ssh FROM wowza_servers WHERE codigo = ?', [serverId])
                .then(([serverRows]) => {
                    if (serverRows.length > 0) {
                        const server = serverRows[0];
                        const connectionKey = `${server.ip}:${server.porta_ssh}`;
                        
                        if (this.connections.has(connectionKey)) {
                            const { conn } = this.connections.get(connectionKey);
                            conn.end();
                            this.connections.delete(connectionKey);
                            console.log(`🔌 Conexão SSH fechada para ${server.ip}`);
                        }
                    }
                });
        } catch (error) {
            console.error('Erro ao fechar conexão SSH:', error);
        }
    }

    closeAllConnections() {
        for (const [key, { conn }] of this.connections) {
            try {
                conn.end();
                console.log(`🔌 Conexão SSH fechada: ${key}`);
            } catch (error) {
                console.error(`Erro ao fechar conexão ${key}:`, error);
            }
        }
        this.connections.clear();
    }
}

module.exports = new SSHManager();