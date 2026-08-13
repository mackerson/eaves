import { Agent, InstructTemplate, ContextFormatting } from '../types';
import { logger } from './logger';
import { getProviderAdapter } from './providers';

/**
 * Message Formatter Service
 *
 * Handles:
 * - Mustache variable replacement ({{var}})
 * - Instruct template application (prefix/suffix sequences)
 * - Stopping strings preparation
 * - Context formatting options
 */

interface FormatterMessage {
  role: 'user' | 'assistant';
  content: string;
  name?: string;
  metadata?: Record<string, any>;
  toolCalls?: any[];
}

interface FormattedResult {
  messages: FormatterMessage[];
  systemPrompt?: string;
  stoppingStrings?: string[];
  useRawPrompt?: boolean;  // For Ollama/LMStudio with templates
  rawPrompt?: string;  // Formatted single-string prompt
}

export class MessageFormatter {
  /**
   * Apply mustache-style variable replacement
   */
  private static replaceMustacheVariables(
    text: string,
    variables: Record<string, string>
  ): string {
    let result = text;

    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      result = result.replace(pattern, value);
    }

    return result;
  }

  /**
   * Apply context formatting options
   */
  private static applyContextFormatting(
    text: string,
    formatting?: ContextFormatting
  ): string {
    if (!formatting) return text;

    let result = text;

    if (formatting.trimSpaces) {
      result = result.trim();
    }

    if (formatting.collapseConsecutiveNewlines) {
      result = result.replace(/\n{3,}/g, '\n\n');
    }

    if (formatting.trimIncompleteSentences) {
      // Remove trailing incomplete sentences (text after last sentence-ending punctuation)
      const lastPunctuation = Math.max(
        result.lastIndexOf('.'),
        result.lastIndexOf('!'),
        result.lastIndexOf('?')
      );
      if (lastPunctuation > 0 && lastPunctuation < result.length - 1) {
        const afterPunctuation = result.substring(lastPunctuation + 1).trim();
        // Only trim if there's actual content after (not just whitespace)
        if (afterPunctuation.length > 0 && !afterPunctuation.match(/^[.!?]+$/)) {
          result = result.substring(0, lastPunctuation + 1);
        }
      }
    }

    return result;
  }

  /**
   * Apply message sequence (prefix + content + suffix)
   */
  private static applyMessageSequence(
    content: string,
    sequence: { prefix: string; suffix: string } | undefined,
    variables: Record<string, string>,
    replaceMacro: boolean,
    wrapWithNewline: boolean
  ): string {
    if (!sequence) return content;

    let prefix = sequence.prefix;
    let suffix = sequence.suffix;

    // Apply mustache replacement in sequences if enabled
    if (replaceMacro) {
      prefix = this.replaceMustacheVariables(prefix, variables);
      suffix = this.replaceMustacheVariables(suffix, variables);
    }

    // Wrap with newlines if enabled
    if (wrapWithNewline) {
      return `\n${prefix}${content}${suffix}\n`;
    }

    return `${prefix}${content}${suffix}`;
  }

  /**
   * Build context variables from message metadata and agent settings
   */
  private static buildContextVariables(
    agent: Agent,
    messages: FormatterMessage[],
    userName: string
  ): Record<string, string> {
    // Start with agent-defined variables
    const variables: Record<string, string> = {
      ...agent.contextVariables,
      user: userName,
      char: agent.name,
      description: agent.description,
    };

    // Extract character name from first assistant message if available
    const firstAssistant = messages.find(m => m.role === 'assistant');
    if (firstAssistant?.name) {
      variables.char = firstAssistant.name;
    }

    // Extract user name from metadata if available
    const firstUser = messages.find(m => m.role === 'user');
    if (firstUser?.metadata?.displayName) {
      variables.user = firstUser.metadata.displayName;
    }

    return variables;
  }

  /**
   * Format messages with instruct template
   */
  private static formatWithInstructTemplate(
    messages: FormatterMessage[],
    template: InstructTemplate,
    variables: Record<string, string>,
    systemPrompt?: string
  ): string {
    const parts: string[] = [];

    // Add system prompt if present
    if (systemPrompt && template.systemPromptSequence) {
      const formattedSystem = this.applyMessageSequence(
        systemPrompt,
        template.systemPromptSequence,
        variables,
        template.replaceMacroInSequences || false,
        template.wrapSequencesWithNewline || false
      );
      parts.push(formattedSystem);
    }

    // Process each message
    for (const message of messages) {
      let sequence = undefined;
      let name = message.name || '';

      // Determine which sequence to use
      if (message.role === 'user') {
        sequence = template.userMessageSequence;
        if (template.includeNames === 'always' || template.includeNames === 'auto') {
          variables.name = name || variables.user;
        }
      } else if (message.role === 'assistant') {
        sequence = template.assistantMessageSequence;
        if (template.includeNames === 'always' || template.includeNames === 'auto') {
          variables.name = name || variables.char;
        }
      }

      // Skip if no sequence (shouldn't happen with user/assistant)
      if (!sequence) continue;

      const formattedMessage = this.applyMessageSequence(
        message.content,
        sequence,
        variables,
        template.replaceMacroInSequences || false,
        template.wrapSequencesWithNewline || false
      );

      parts.push(formattedMessage);

      // Add separator if defined
      if (template.separatorSequence) {
        parts.push(template.separatorSequence);
      }
    }

    // Add assistant prompt prefix (common pattern - start the assistant's response)
    if (template.assistantMessageSequence?.prefix) {
      parts.push(template.assistantMessageSequence.prefix);
    }

    return parts.join('');
  }

  /**
   * Collect stopping strings from template and agent settings
   */
  public static collectStoppingStrings(
    agent: Agent,
    template?: InstructTemplate,
    formatting?: ContextFormatting
  ): string[] {
    const stopStrings = new Set<string>();

    // Add agent-defined stopping strings
    if (agent.stoppingStrings) {
      agent.stoppingStrings.forEach(s => stopStrings.add(s));
    }

    // Add template stop sequence
    if (template?.stopSequence) {
      if (template.stopSequence.prefix) stopStrings.add(template.stopSequence.prefix);
      if (template.stopSequence.suffix) stopStrings.add(template.stopSequence.suffix);
    }

    // Add separators as stop strings if enabled
    if (formatting?.separatorsAsStopStrings && template?.separatorSequence) {
      stopStrings.add(template.separatorSequence);
    }

    // Note: namesAsStopStrings would require knowing all participant names,
    // which we'll handle at the call site if needed

    return Array.from(stopStrings);
  }

  /**
   * Check if template should be activated based on regex
   */
  private static shouldActivateTemplate(
    agent: Agent,
    template: InstructTemplate
  ): boolean {
    if (!template.activationRegex) return true;

    try {
      // Parse regex from string like "/pattern/flags"
      const match = template.activationRegex.match(/^\/(.+)\/([gimuy]*)$/);
      if (match) {
        const pattern = match[1];
        const flags = match[2];
        const regex = new RegExp(pattern, flags);
        return regex.test(agent.model);
      } else {
        // Treat as plain string if not in regex format
        return agent.model.includes(template.activationRegex);
      }
    } catch (error) {
      logger.warn('Invalid activation regex', { regex: template.activationRegex, error });
      return true;
    }
  }

  /**
   * Main formatting function
   */
  public static formatMessages(
    agent: Agent,
    messages: FormatterMessage[],
    systemPrompt: string,
    userName: string = 'User'
  ): FormattedResult {
    logger.debug('Formatting messages', {
      messageCount: messages.length,
      hasInstructTemplate: !!agent.instructTemplate,
      hasContextVariables: !!agent.contextVariables,
      hasStoppingStrings: !!agent.stoppingStrings
    });

    // Build context variables
    const variables = this.buildContextVariables(agent, messages, userName);

    // Apply mustache variables to system prompt
    let formattedSystemPrompt = systemPrompt;
    if (agent.contextVariables || agent.instructTemplate?.replaceMacroInSequences) {
      formattedSystemPrompt = this.replaceMustacheVariables(systemPrompt, variables);
    }

    // Apply context formatting to system prompt
    if (agent.contextFormatting) {
      formattedSystemPrompt = this.applyContextFormatting(
        formattedSystemPrompt,
        agent.contextFormatting
      );
    }

    // Collect stopping strings
    const stoppingStrings = this.collectStoppingStrings(
      agent,
      agent.instructTemplate,
      agent.contextFormatting
    );

    // Check if we should use instruct template
    const useTemplate = agent.instructTemplate &&
      this.shouldActivateTemplate(agent, agent.instructTemplate);

    if (useTemplate && agent.instructTemplate) {
      logger.info('Using instruct template', {
        templateName: agent.instructTemplate.name,
        provider: agent.provider
      });

      // Raw single-string prompt is only for providers whose capability map
      // says so (local runtimes today) — driven by the capability flag rather
      // than a hardcoded provider list, so a new raw-capable provider works.
      const caps = getProviderAdapter(agent.provider)?.getCapabilities(agent.model);
      if (caps?.rawPrompt) {
        const rawPrompt = this.formatWithInstructTemplate(
          messages,
          agent.instructTemplate,
          variables,
          formattedSystemPrompt
        );

        logger.debug('Generated raw prompt', {
          length: rawPrompt.length,
          preview: rawPrompt.substring(0, 200)
        });

        return {
          messages: [],  // Empty - we're using raw prompt instead
          systemPrompt: undefined,  // Included in raw prompt
          stoppingStrings: stoppingStrings.length > 0 ? stoppingStrings : undefined,
          useRawPrompt: true,
          rawPrompt
        };
      }
    }

    // Standard message format (for Anthropic/OpenAI or when no template)
    // Apply context formatting to messages if needed
    let formattedMessages = messages;
    if (agent.contextFormatting) {
      formattedMessages = messages.map(m => ({
        ...m,
        content: this.applyContextFormatting(m.content, agent.contextFormatting)
      }));
    }

    return {
      messages: formattedMessages,
      systemPrompt: formattedSystemPrompt,
      stoppingStrings: stoppingStrings.length > 0 ? stoppingStrings : undefined,
      useRawPrompt: false
    };
  }
}
