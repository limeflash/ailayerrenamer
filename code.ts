let OPENROUTER_API_KEY = '';
let ANALYSIS_MODEL = '';
let RENAMING_MODEL = '';

function logWithoutSensitiveData(data: any) {
  const sanitized = JSON.parse(JSON.stringify(data));
  if (sanitized.headers && sanitized.headers.Authorization) {
    sanitized.headers.Authorization = 'Bearer [REDACTED]';
  }
  console.log(JSON.stringify(sanitized, null, 2));
}

interface LayerInfo {
  id: string;
  name: string;
  type: string;
  children: LayerInfo[];
}

const systemMessage = `You are an AI assistant specialized in analyzing UI screenshots. Your task is to provide a brief, focused context of the UI in the image. Follow these strict guidelines:

1. Identify the type of application or website (e.g., e-commerce, social media, productivity app).
2. Describe the main purpose or function of the visible UI (e.g., product page, user profile, dashboard).
3. List the key UI elements present (e.g., header, navigation menu, content area, sidebar).
4. Mention any prominent features or interactive elements (e.g., search bar, login form, product grid).
5. Note the overall color scheme and any standout visual elements.

Provide only the essential context in 3-5 concise sentences. Do not include any analysis, suggestions, or explanations beyond the direct observation of the UI elements.`;

figma.showUI(__html__, { width: 450, height: 550 });

function getLayerInfo(node: SceneNode): LayerInfo {
  const info: LayerInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
    children: [],
  };

  if ('children' in node) {
    info.children = node.children.map(getLayerInfo);
  }

  return info;
}

function countLayers(layerInfo: LayerInfo): number {
  return 1 + layerInfo.children.reduce((sum, child) => sum + countLayers(child), 0);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i;
  const l = bytes.length;
  for (i = 2; i < l; i += 3) {
    result += base64[bytes[i - 2] >> 2];
    result += base64[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
    result += base64[((bytes[i - 1] & 0x0F) << 2) | (bytes[i] >> 6)];
    result += base64[bytes[i] & 0x3F];
  }
  if (i === l + 1) {
    result += base64[bytes[i - 2] >> 2];
    result += base64[(bytes[i - 2] & 0x03) << 4];
    result += '==';
  }
  if (i === l) {
    result += base64[bytes[i - 2] >> 2];
    result += base64[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
    result += base64[(bytes[i - 1] & 0x0F) << 2];
    result += '=';
  }
  return result;
}

async function captureScreenshot(): Promise<Uint8Array> {
  const nodes = figma.currentPage.selection;
  if (nodes.length === 0) {
    throw new Error('No nodes selected');
  }
  const node = nodes[0];
  if ('exportAsync' in node) {
    try {
      return await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 2 }
      });
    } catch (error) {
      console.error('Error exporting node:', error);
      throw new Error(`Failed to export node: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    throw new Error('Selected node does not support exporting');
  }
}

interface AnalysisResult {
  structure: string;
  colorTheme: string;
}

let analysisResult: AnalysisResult | null = null;

async function analyzeScreenshot(screenshot: Uint8Array): Promise<AnalysisResult> {
  const base64Image = uint8ArrayToBase64(screenshot);

  console.log('OPENROUTER_API_KEY length:', OPENROUTER_API_KEY.length);
  console.log('ANALYSIS_MODEL:', ANALYSIS_MODEL);

  const requestData = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Figma AI Rename Layers Plugin',
      'HTTP-Referer': 'https://www.figma.com/'
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: [
          { type: 'text', text: 'Analyze this UI screenshot and provide a hierarchical structure for layer naming:' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
        ]},
      ],
      max_tokens: 1000,
    }),
  };

  logWithoutSensitiveData(requestData);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', requestData);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('API Error response:', errorText);
    throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;
  
  // Improved structure parsing
  const structureMatch = content.match(/UI Structure:([\s\S]*?)(?=Color Theme:|$)/i);
  const colorThemeMatch = content.match(/Color Theme:([\s\S]*?)$/i);
  
  analysisResult = {
    structure: structureMatch ? structureMatch[1].trim() : content.trim(),
    colorTheme: colorThemeMatch ? colorThemeMatch[1].trim() : ''
  };
  
  console.log('Analysis Result:', analysisResult);  // Added this log for debugging
  
  return analysisResult;
}

function parseAnalysisStructure(structure: string): Record<string, string> {
  const lines = structure.split('\n');
  const result: Record<string, string> = {};
  let currentPath: string[] = [];

  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('-')) {
      const level = (line.length - line.trimLeft().length) / 2;
      const name = trimmedLine.substring(1).trim().split(':')[0].trim();
      
      currentPath = currentPath.slice(0, level);
      currentPath.push(name);
      
      const fullPath = currentPath.join(' > ');
      result[fullPath] = name;
    }
  });

  console.log('Parsed Analysis Structure:', result);  // Added this log for debugging
  return result;
}

async function renameLayerRecursively(
  layerInfo: LayerInfo, 
  newNames: Record<string, string>, 
  analysisNames: Record<string, string>, 
  currentPath: string[] = []
): Promise<number> {
  let renamedCount = 0;
  const node = await figma.getNodeByIdAsync(layerInfo.id);
  if (node) {
    let newName = '';

    // Попытка найти имя из анализа структуры
    const fullPath = currentPath.join(' > ');
    for (const [path, name] of Object.entries(analysisNames)) {
      if (fullPath.endsWith(path)) {
        newName = name;
        break;
      }
    }

    // Если имя не найдено в анализе, используем имя от нейронки
    if (!newName && layerInfo.id in newNames) {
      newName = newNames[layerInfo.id];
    }

    // Если имя найдено, применяем его
    if (newName) {
      node.name = newName;
      renamedCount++;
      console.log(`Renamed: ${layerInfo.name} -> ${newName}`);
    } else {
      console.log(`No new name for: ${layerInfo.name}`);
    }
  }

  // Рекурсивно переименовываем дочерние элементы
  for (const child of layerInfo.children) {
    renamedCount += await renameLayerRecursively(
      child, 
      newNames, 
      analysisNames, 
      [...currentPath, child.name]
    );
  }

  return renamedCount;
}

function generateSimpleName(type: string, path: string[]): string {
  const typePrefix = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
  const pathSuffix = path.length > 0 ? path[path.length - 1] : '';
  return `${typePrefix}${pathSuffix ? '_' + pathSuffix : ''}`;
}

async function simpleRename(layerInfo: LayerInfo, prefix: string = ''): Promise<number> {
  let renamedCount = 0;
  const node = await figma.getNodeByIdAsync(layerInfo.id);
  if (node) {
    const oldName = node.name;
    const newName = prefix ? `${prefix}-${renamedCount + 1}` : `${renamedCount + 1}`;
    node.name = newName;
    renamedCount++;
    console.log(`Renamed: ${oldName} -> ${newName}`);
  }

  for (const child of layerInfo.children) {
    const childPrefix = prefix ? `${prefix}-${renamedCount}` : `${renamedCount}`;
    renamedCount += await simpleRename(child, childPrefix);
  }

  return renamedCount;
}

function updateSelectionInfo() {
  const selection = figma.currentPage.selection;
  const selectedLayers = selection.length;
  const totalLayers = selection.reduce((sum, node) => sum + countLayers(getLayerInfo(node)), 0);
  
  figma.ui.postMessage({ 
    type: 'selectionUpdate', 
    selectedCount: selectedLayers,
    totalCount: totalLayers
  });
}

figma.on('selectionchange', updateSelectionInfo);

figma.ui.onmessage = async (msg: { type: string; temperature?: number; context?: string; apiKey?: string; analysisModel?: string; renamingModel?: string }) => {
  console.log('Received message:', msg);
  if (msg.type === 'loadSettings') {
    const apiKey = await figma.clientStorage.getAsync('apiKey') || '';
    const analysisModel = await figma.clientStorage.getAsync('analysisModel') || '';
    const renamingModel = await figma.clientStorage.getAsync('renamingModel') || '';
    figma.ui.postMessage({ type: 'settingsLoaded', apiKey, analysisModel, renamingModel });
  } else if (msg.type === 'saveSettings') {
    OPENROUTER_API_KEY = msg.apiKey || '';
    ANALYSIS_MODEL = msg.analysisModel || '';
    RENAMING_MODEL = msg.renamingModel || '';
    await figma.clientStorage.setAsync('apiKey', OPENROUTER_API_KEY);
    await figma.clientStorage.setAsync('analysisModel', ANALYSIS_MODEL);
    await figma.clientStorage.setAsync('renamingModel', RENAMING_MODEL);
    console.log('Settings saved');
  } else if (msg.type === 'start-analysis') {
    try {
      const screenshot = await captureScreenshot();
      analysisResult = await analyzeScreenshot(screenshot);
      figma.ui.postMessage({ 
        type: 'context', 
        structure: analysisResult.structure,
        colorTheme: analysisResult.colorTheme,
        screenshot: Array.from(screenshot)
      });
    } catch (error) {
      console.error('Analysis error:', error);
      figma.ui.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error occurred' });
    }
  } else if (msg.type === 'start-renaming') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: 'error', message: 'No layers selected' });
      return;
    }

    const layerInfos = selection.map(getLayerInfo);
    const context = msg.context || '';
    const temperature = msg.temperature || 0.7;

    if (!analysisResult) {
      figma.ui.postMessage({ type: 'error', message: 'Please analyze the screenshot first' });
      return;
    }

    console.log('Analysis Result:', analysisResult);  // Added this log
    const analysisNames = parseAnalysisStructure(analysisResult.structure);
    console.log('Parsed analysis names:', analysisNames);

    const renamingSystemMessage = `You are an AI assistant specialized in renaming Figma layers.
Your task is to provide concise and descriptive names for each layer based on their context, hierarchy, and type.
The layers have been pre-renamed with a simple numeric structure (e.g., 1-1-1, 1-1-2, 1-2, etc.).
Use this structure to understand the hierarchy and provide appropriate names.
Follow these guidelines:
1. Use PascalCase for main components and camelCase for sub-components.
2. Keep names short and descriptive, focusing on the purpose of the element.
3. Use common UI terms (e.g., Header, Footer, NavBar, SearchBar).
4. For repeated elements, use numbers or descriptive suffixes (e.g., "Feature1", "Feature2" or "SearchIcon", "NotificationIcon").
5. Ensure names are unique within their parent context.
6. Use the provided UI structure as a guide for naming, but improve upon it if necessary.

The response should be a JSON object with layer IDs as keys and new names as values.
Provide names for ALL layers in the input, without exception.
Only respond with JSON and nothing else!!!`;

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'Figma AI Rename Layers Plugin',
          'HTTP-Referer': 'https://www.figma.com/'
        },
        body: JSON.stringify({
          model: RENAMING_MODEL,
          messages: [
            { role: 'system', content: renamingSystemMessage },
            { role: 'user', content: `Context:\n${context}\n\nRename ALL of the following layers. Respond only with a JSON object containing names for EVERY layer:\n\n${JSON.stringify(layerInfos, null, 2)}` },
          ],
          temperature: temperature,
          max_tokens: 8000,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('API Error:', errorData);
        throw new Error(`API request failed: ${response.status} ${response.statusText}. ${errorData.error?.message || ''}`);
      }

      const data = await response.json();
      console.log('API Response:', data);

      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
        throw new Error('Invalid API response structure: missing or empty choices array');
      }

      const aiResponse = data.choices[0].message?.content;
      if (!aiResponse) {
        throw new Error('Invalid API response structure: missing content in the first choice');
      }

      console.log('AI Response:', aiResponse);

      let newNames;
      try {
        const cleanedResponse = aiResponse.replace(/```json\s*|\s*```/g, '').trim();
        newNames = JSON.parse(cleanedResponse);
      } catch (parseError) {
        console.error('Failed to parse AI response:', parseError);
        console.error('Raw AI response:', aiResponse);
        throw new Error('Invalid response format from AI. Expected JSON object with layer names.');
      }

      if (typeof newNames !== 'object' || newNames === null || Object.keys(newNames).length === 0) {
        throw new Error('Invalid or empty response from AI');
      }

      console.log('AI-generated names:', newNames);

      let totalRenamedCount = 0;
      for (const layerInfo of layerInfos) {
        totalRenamedCount += await renameLayerRecursively(layerInfo, newNames, analysisNames);
      }

      console.log(`Total renamed layers: ${totalRenamedCount}`);
      figma.ui.postMessage({ type: 'complete', renamedCount: totalRenamedCount });
    } catch (error) {
      console.error('Renaming error:', error);
      figma.ui.postMessage({ 
        type: 'error', 
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        details: error instanceof Error ? error.stack : ''
      });
      // Add a delay before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
      figma.ui.postMessage({ type: 'retryEnabled' });
    }
  } else if (msg.type === 'start-simple-renaming') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: 'error', message: 'No layers selected' });
      return;
    }

    console.log('Starting simple renaming...');
    const layerInfos = selection.map(getLayerInfo);
    let totalRenamedCount = 0;

    for (let i = 0; i < layerInfos.length; i++) {
      const renamedCount = await simpleRename(layerInfos[i], (i + 1).toString());
      totalRenamedCount += renamedCount;
      console.log(`Renamed ${renamedCount} layers in selection ${i + 1}`);
    }

    console.log(`Simple rename complete. Total renamed layers: ${totalRenamedCount}`);
    figma.ui.postMessage({ type: 'complete', renamedCount: totalRenamedCount });
  } else if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};

figma.on('run', updateSelectionInfo);