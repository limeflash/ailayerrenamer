let OPENROUTER_API_KEY = '';
let ANALYSIS_MODEL = '';

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

const systemMessage = `You are an AI assistant specialized in analyzing UI screenshots and renaming layers. Your task is to provide a brief, focused context of the UI in the image and suggest appropriate names for the layers. Follow these guidelines:

1. Identify the type of application or website.
2. Describe the main purpose or function of the visible UI.
3. List the key UI elements present.
4. Suggest names for the layers based on their function and hierarchy.
5. Use clear, descriptive names without underscores or dashes.

Provide the essential context in 3-5 concise sentences, followed by a JSON object containing layer IDs as keys and suggested names as values.`;

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

async function analyzeAndRename(screenshot: Uint8Array, layerInfo: LayerInfo): Promise<void> {
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
          { type: 'text', text: 'Analyze this UI screenshot and suggest names for the layers. Here is the current layer structure:' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
          { type: 'text', text: JSON.stringify(layerInfo, null, 2) }
        ]},
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
  
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object found in the AI response');
  }

  const newNames = JSON.parse(jsonMatch[0]);
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
    context: content.replace(jsonMatch[0], '').trim()
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

figma.ui.onmessage = async (msg: { type: string; apiKey?: string; analysisModel?: string; }) => {
  console.log('Received message:', msg);
  if (msg.type === 'loadSettings') {
    const apiKey = await figma.clientStorage.getAsync('apiKey') || '';
    const analysisModel = await figma.clientStorage.getAsync('analysisModel') || '';
    figma.ui.postMessage({ type: 'settingsLoaded', apiKey, analysisModel });
  } else if (msg.type === 'saveSettings') {
    OPENROUTER_API_KEY = msg.apiKey || '';
    ANALYSIS_MODEL = msg.analysisModel || '';
    await figma.clientStorage.setAsync('apiKey', OPENROUTER_API_KEY);
    await figma.clientStorage.setAsync('analysisModel', ANALYSIS_MODEL);
    console.log('Settings saved');
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

figma.on('run', updateSelectionInfo);

async function applyRemainingNames(layerInfo: LayerInfo, newNames: Record<string, string>, unusedNames: string[]): Promise<void> {
  const applyToNode = async (node: BaseNode) => {
    if ('name' in node) {
      for (const unusedName of unusedNames) {
        if (node.name.toLowerCase().includes(unusedName.toLowerCase())) {
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
}