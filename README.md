# AI Layer Renaming Plugin for Figma

This Figma plugin uses AI to analyze UI screenshots and intelligently rename layers based on their function and context.

## Features

- Captures screenshots of selected Figma frames
- Analyzes UI screenshots using AI
- Generates contextual layer names based on UI analysis
- Applies new names to layers automatically
- Supports fuzzy matching for improved name application

## Setup

1. Install [Node.js](https://nodejs.org/en/download/) (includes NPM)
2. Install TypeScript globally:
   ```
   npm install -g typescript
   ```
3. In the plugin directory, install Figma plugin typings:
   ```
   npm install --save-dev @figma/plugin-typings
   ```

## Configuration

The plugin requires the following settings:

- OpenRouter API Key
- Screenshot Analysis Model
- Layer Naming Model

These can be set and saved within the plugin interface.

## Usage

1. Select a frame or component in your Figma file
2. Run the plugin
3. Configure API settings if not already set
4. Click "Start Renaming" to begin the AI-powered renaming process

## Development

We recommend using Visual Studio Code:

1. [Download Visual Studio Code](https://code.visualstudio.com/)
2. Open the plugin directory in VS Code
3. Start TypeScript compilation:
   - Select "Terminal > Run Build Task..."
   - Choose "npm: watch"

VS Code will automatically recompile JavaScript each time you save.

## Additional Information

- [Figma Plugin API Documentation](https://www.figma.com/plugin-docs/plugin-quickstart-guide/)
- [TypeScript Official Website](https://www.typescriptlang.org/)
- [OpenRouter API Documentation](https://openrouter.ai/docs)
