import { memo } from 'react';
import { NodeProps } from 'reactflow';
import { BaseWorkflowNode } from './BaseWorkflowNode';
import { WebScraperNodeConfig } from './configs';

export const WebScraperNode = memo(({ data, id }: NodeProps<Record<string, any>>) => {
  return (
    <BaseWorkflowNode
      id={id}
      data={data}
      icon="🌐"
      fallbackLabel={"Scrape page"}
      className="web-scraper-node"
    >
      <WebScraperNodeConfig id={id} data={data} />
    </BaseWorkflowNode>
  );
});

WebScraperNode.displayName = 'WebScraperNode';
