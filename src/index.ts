/* eslint-disable no-console */
import OpenAI from 'openai';
import USCoreEncounterProfile from './StructureDefinition-us-core-encounter.json';
import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { parseArgs } from 'util';

const openai = new OpenAI({
  organization: process.env.OPENAI_ORG,
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      input: {
        type: 'string',
      },
    },
    strict: true,
    allowPositionals: true,
  });

  if (!values.input) {
    console.error('Please provide an input file');
    process.exit(1);
  }

  const file = Bun.file(values.input);
  const input = await file.text();

  const prompt: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are the transform layer of an ETL.
        You take raw healthcare resources and format them into a FHIR Resources.
        You have access to a FHIR Server with a $validate operation to help you in this task - which can validate resources.
        You also have access to a UUID generator tool.
        Your goal is to produce a working, validated Resource.
      `,
    },
    {
      role: 'user',
      content: `
        The next request in your pipeline involves transforming a raw clinical encounter note into a US Core Encounter FHIR Resource.
    
        The Encounter resource MUST conform to a the US Core profile, provided by the following structure definition:

        ${JSON.stringify(USCoreEncounterProfile)}
            
        Here is the clinical encounter note::

        ${input}
    
        Please make sure that:

        * Always return as JSON
        * Use a contained references for other relationships like to the Patient
        * NEVER infer codeable concepts from free text. Only use explicitly provided systems.
        * Do not create unnecessary identifiers
      `,
    }
  ];

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'fhir-validate',
        description: 'Validates a FHIR Enocunter Resource against US Core',
        parameters: {
          type: 'object',
          properties: {
            resource: {
              type: 'object',
              description: 'The FHIR Encounter resource to validate',
            },
          },
          required: ['resource'],
        },
      },
    },
    // UUIDv4 tool
    {
      type: 'function',
      function: {
        name: 'uuidv4',
        description: 'Generates a UUIDv4',
      },
    },
  ];

  await complete(prompt, tools);
}

async function complete(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
) {
  console.log('⏩ Requesting completion from OpenAI...');
  const completion = await openai.chat.completions.create({
    messages,
    model: 'gpt-4o',
    tools,
    response_format: {
      type: 'json_object',
    },
  });

  messages.push(completion.choices[0].message);

  const tool_calls = completion.choices[0].message.tool_calls;

  if (tool_calls) {
    // Loop through each tool call
    for (const tool_call of tool_calls) {
      const tool_call_id = tool_call.id;
      const tool_function_name = tool_call.function.name;
      const tool_function_argument = JSON.parse(tool_call.function.arguments);


      // Step 3: Call the function and retrieve results. Append the results to the messages list.
      if (tool_function_name === 'fhir-validate') {
        console.log('⏪ FHIR $validate tool use');
        const results = await validate(tool_function_argument);

        console.log(results)

        messages.push({
          role: 'tool',
          tool_call_id: tool_call_id,
          content: JSON.stringify(results),
        });
      } else if (tool_function_name === 'uuidv4') {
        console.log('⏪ uuidv4 tool use');
        messages.push({
          role: 'tool',
          tool_call_id: tool_call_id,
          content: randomUUID(),
        });
      }
    }
    await complete(messages, tools);
  } else {
    writeFileSync(
      'out.json',
      JSON.stringify(JSON.parse(completion.choices[0].message.content as string)),
      'utf-8',
    );
  }
}

async function validate(resource: unknown) {
  const response = await fetch("https://inferno.healthit.gov/validatorapi/validate?profile=http%3A%2F%2Fhl7.org%2Ffhir%2Fus%2Fcore%2FStructureDefinition%2Fus-core-encounter", {
    headers: {
      "content-type": "application/fhir+json",
    },
    body: JSON.stringify(resource),
    method: "POST",
  });

  return await response.json();
}

main();
