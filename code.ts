let OPENROUTER_API_KEY = '';
let SCREENSHOT_ANALYSIS_MODEL = '';
let LAYER_NAMING_MODEL = '';

// Add this function to load settings
async function loadSettings() {
  OPENROUTER_API_KEY = await figma.clientStorage.getAsync('apiKey') || '';
  SCREENSHOT_ANALYSIS_MODEL = await figma.clientStorage.getAsync('screenshotAnalysisModel') || '';
  LAYER_NAMING_MODEL = await figma.clientStorage.getAsync('layerNamingModel') || '';
}

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

const screenshotAnalysisMessage = `You are an AI assistant specialized in analyzing UI screenshots. Your task is to provide a brief, focused context of the UI in the image. Follow these guidelines:

1. Identify the type of application or website.
2. Describe the main purpose or function of the visible UI.
3. List the key UI elements present.

Provide the essential context in 3-5 concise sentences.`;

const layerNamingMessage = `You are an AI assistant specialized in renaming layers based on UI analysis. Your task is to suggest appropriate names for the layers based on the provided UI analysis and layer structure. Follow these guidelines:

1. Use the UI analysis to understand the context and purpose of the interface.
2. Suggest names for the layers based on their function and hierarchy.
3. Use clear, descriptive names without underscores or dashes.

Provide a JSON object containing layer IDs as keys and suggested names as values.`;

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

async function analyzeScreenshot(screenshot: Uint8Array): Promise<string> {
  const base64Image = uint8ArrayToBase64(screenshot);

  const requestData = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Figma AI Rename Layers Plugin',
      'HTTP-Referer': 'https://www.figma.com/'
    },
    body: JSON.stringify({
      model: SCREENSHOT_ANALYSIS_MODEL,
      messages: [
        { role: 'system', content: screenshotAnalysisMessage },
        { role: 'user', content: [
          { type: 'text', text: 'Analyze this UI screenshot:' },
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
  return data.choices[0].message.content;
}

async function generateLayerNames(uiAnalysis: string, layerInfo: LayerInfo): Promise<Record<string, string>> {
  const requestData = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Figma AI Rename Layers Plugin',
      'HTTP-Referer': 'https://www.figma.com/'
    },
    body: JSON.stringify({
      model: LAYER_NAMING_MODEL,
      messages: [
        { role: 'system', content: layerNamingMessage },
        { role: 'user', content: `UI Analysis: ${uiAnalysis}\n\nLayer Structure: ${JSON.stringify(layerInfo, null, 2)}` },
      ],
      max_tokens: 2000,
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

  console.log("AI Response:", content);

  let newNames: Record<string, string> = {};

  // Try to extract JSON object
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      newNames = JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error("Error parsing JSON:", error);
    }
  }

  // If no JSON object found or parsing failed, try to extract names from the text
  if (Object.keys(newNames).length === 0) {
    const nameMatches = content.match(/([a-zA-Z]+):\s*([a-zA-Z]+)/g);
    if (nameMatches) {
      nameMatches.forEach((match: string) => {
        const [key, value] = match.split(':').map((s: string) => s.trim());
        newNames[key] = value;
      });
    }
  }

  console.log("Extracted names:", newNames);

  return newNames;
}

async function analyzeAndRename(screenshot: Uint8Array, layerInfo: LayerInfo): Promise<void> {
  const uiAnalysis = await analyzeScreenshot(screenshot);
  console.log("UI Analysis:", uiAnalysis);

  const newNames = await generateLayerNames(uiAnalysis, layerInfo);

  await applyNewNames(layerInfo, newNames);

  // Проверка применения всех имен
  const unusedNames = Object.keys(newNames).filter(id => !checkNameApplied(layerInfo, id));
  if (unusedNames.length > 0) {
    console.warn(`Warning: Some names were not applied: ${unusedNames.join(', ')}`);
    figma.ui.postMessage({ 
      type: 'warning', 
      message: `Some names were not applied. Check console for details.`
    });
  }

  // Добавим дополнительную проверку и попытку применить оставшиеся имена
  if (unusedNames.length > 0) {
    console.log("Attempting to apply remaining names...");
    await applyRemainingNames(layerInfo, newNames, unusedNames);
  }

  figma.ui.postMessage({ 
    type: 'complete', 
    message: 'Renaming complete',
    context: uiAnalysis
  });
}

async function applyNewNames(layerInfo: LayerInfo, newNames: Record<string, string>): Promise<void> {
  const node = await figma.getNodeByIdAsync(layerInfo.id);
  if (node) {
    if (layerInfo.id in newNames) {
      node.name = newNames[layerInfo.id];
      console.log(`Renamed: ${layerInfo.name} -> ${newNames[layerInfo.id]}`);
    } else {
      // Если нет нового имени по ID, попробуем найти по старому имени
      const newName = newNames[layerInfo.name] || newNames[`Layer_${layerInfo.id}`];
      if (newName) {
        node.name = newName;
        console.log(`Renamed: ${layerInfo.name} -> ${newName}`);
      } else {
        console.log(`No new name for: ${layerInfo.name}, keeping original name`);
      }
    }
  } else {
    console.error(`Node not found for id: ${layerInfo.id}`);
  }

  for (const child of layerInfo.children) {
    await applyNewNames(child, newNames);
  }
}

function checkNameApplied(layerInfo: LayerInfo, id: string): boolean {
  if (layerInfo.id === id) return true;
  return layerInfo.children.some(child => checkNameApplied(child, id));
}

async function renameLayersRecursively(layerInfo: LayerInfo, newNames: Record<string, string>): Promise<void> {
  const node = await figma.getNodeByIdAsync(layerInfo.id);
  if (node) {
    if (layerInfo.id in newNames) {
      node.name = newNames[layerInfo.id];
      console.log(`Renamed: ${layerInfo.name} -> ${newNames[layerInfo.id]}`);
    } else {
      console.log(`No new name for: ${layerInfo.name}`);
    }
  }

  for (const child of layerInfo.children) {
    await renameLayersRecursively(child, newNames);
  }
}

async function simpleRename(layerInfo: LayerInfo, prefix: string = ''): Promise<void> {
  const node = await figma.getNodeByIdAsync(layerInfo.id);
  if (node) {
    const newName = prefix ? `${prefix}` : 'Layer';
    node.name = newName;
    console.log(`Renamed: ${layerInfo.name} -> ${newName}`);
  }

  for (let i = 0; i < layerInfo.children.length; i++) {
    const child = layerInfo.children[i];
    const childPrefix = prefix ? `${prefix}_${i + 1}` : `${i + 1}`;
    await simpleRename(child, childPrefix);
  }
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

figma.ui.onmessage = async (msg: { type: string; apiKey?: string; screenshotAnalysisModel?: string; layerNamingModel?: string; }) => {
  console.log('Received message:', msg);
  if (msg.type === 'loadSettings') {
    await loadSettings();
    figma.ui.postMessage({ type: 'settingsLoaded', apiKey: OPENROUTER_API_KEY, screenshotAnalysisModel: SCREENSHOT_ANALYSIS_MODEL, layerNamingModel: LAYER_NAMING_MODEL });
  } else if (msg.type === 'useLoadedSettings' || msg.type === 'saveSettings') {
    OPENROUTER_API_KEY = msg.apiKey || '';
    SCREENSHOT_ANALYSIS_MODEL = msg.screenshotAnalysisModel || '';
    LAYER_NAMING_MODEL = msg.layerNamingModel || '';
    
    if (msg.type === 'saveSettings') {
      await figma.clientStorage.setAsync('apiKey', OPENROUTER_API_KEY);
      await figma.clientStorage.setAsync('screenshotAnalysisModel', SCREENSHOT_ANALYSIS_MODEL);
      await figma.clientStorage.setAsync('layerNamingModel', LAYER_NAMING_MODEL);
      console.log('Settings saved');
    } else {
      console.log('Using loaded settings');
    }
  } else if (msg.type === 'start-renaming') {
    try {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.ui.postMessage({ type: 'error', message: 'No layers selected' });
        return;
      }

      const layerInfo = getLayerInfo(selection[0]);
      await simpleRename(layerInfo);
      
      const screenshot = await captureScreenshot();
      await analyzeAndRename(screenshot, layerInfo);
    } catch (error) {
      console.error('Renaming error:', error);
      figma.ui.postMessage({ 
        type: 'error', 
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        details: error instanceof Error ? error.stack : ''
      });
    }
  } else if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};

// Modify the 'run' event handler
figma.on('run', async () => {
  await loadSettings();
  updateSelectionInfo();
});

async function applyRemainingNames(layerInfo: LayerInfo, newNames: Record<string, string>, unusedNames: string[]): Promise<void> {
  const applyToNode = async (node: BaseNode) => {
    if ('name' in node) {
      for (const unusedName of unusedNames) {
        // Convert both names to lowercase for case-insensitive comparison
        const nodeName = node.name.toLowerCase();
        const unusedNameLower = unusedName.toLowerCase();
        
        // Check if the node name contains any part of the unused name
        if (nodeName.includes(unusedNameLower) || 
            unusedNameLower.includes(nodeName) ||
            nodeName.replace(/[^a-z0-9]/g, '').includes(unusedNameLower.replace(/[^a-z0-9]/g, ''))) {
          node.name = newNames[unusedName];
          console.log(`Applied remaining name: ${node.name} -> ${newNames[unusedName]}`);
          unusedNames.splice(unusedNames.indexOf(unusedName), 1);
          break;
        }
      }
    }
  };

  const traverseNodes = async (node: BaseNode) => {
    await applyToNode(node);
    if ('children' in node) {
      for (const child of node.children) {
        await traverseNodes(child);
      }
    }
  };

  const rootNode = await figma.getNodeByIdAsync(layerInfo.id);
  if (rootNode) {
    await traverseNodes(rootNode);
  }

  // If there are still unused names, try to find the closest match
  if (unusedNames.length > 0) {
    console.log("Attempting to apply remaining names with fuzzy matching...");
    await applyRemainingNamesFuzzy(layerInfo, newNames, unusedNames);
  }
}

async function applyRemainingNamesFuzzy(layerInfo: LayerInfo, newNames: Record<string, string>, unusedNames: string[]): Promise<void> {
  const applyToNode = async (node: BaseNode) => {
    if ('name' in node) {
      const nodeName = node.name.toLowerCase();
      let bestMatch = '';
      let bestScore = 0;

      for (const unusedName of unusedNames) {
        const unusedNameLower = unusedName.toLowerCase();
        const score = calculateSimilarity(nodeName, unusedNameLower);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = unusedName;
        }
      }

      if (bestMatch && bestScore > 0.5) { // Adjust this threshold as needed
        node.name = newNames[bestMatch];
        console.log(`Applied fuzzy match: ${node.name} -> ${newNames[bestMatch]}`);
        unusedNames.splice(unusedNames.indexOf(bestMatch), 1);
      }
    }
  };

  const traverseNodes = async (node: BaseNode) => {
    await applyToNode(node);
    if ('children' in node) {
      for (const child of node.children) {
        await traverseNodes(child);
      }
    }
  };

  const rootNode = await figma.getNodeByIdAsync(layerInfo.id);
  if (rootNode) {
    await traverseNodes(rootNode);
  }
}

function calculateSimilarity(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const maxLen = Math.max(len1, len2);
  let matches = 0;

  for (let i = 0; i < maxLen; i++) {
    if (str1[i] === str2[i]) {
      matches++;
    }
  }

  return matches / maxLen;
}