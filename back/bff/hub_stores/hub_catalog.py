"""Internal catalog contract, independent of BFF screen payloads and external exports."""
import json
from uuid import UUID

from fastapi import HTTPException

from bff.hub_stores import analytics_db


async def listing(kind, limit, offset, project_id=None):
    if kind not in ('projects','prompts'):
        raise HTTPException(404, 'Unknown HUB catalog')
    try:
        project = UUID(project_id) if project_id else None
    except ValueError:
        raise HTTPException(400, 'project_id must be a UUID')
    view = 'current_project' if kind == 'projects' else 'current_prompt'
    key = 'project_id' if kind == 'projects' else 'prompt_id'
    try:
        async with analytics_db.connection() as conn:
            total = await conn.fetchval(f'SELECT count(*) FROM catalog.{view} WHERE ($1::uuid IS NULL OR project_id=$1)', project)
            rows = await conn.fetch(f'SELECT * FROM catalog.{view} WHERE ($1::uuid IS NULL OR project_id=$1) ORDER BY {key} LIMIT $2 OFFSET $3', project,limit,offset)
    except ConnectionError:
        raise HTTPException(503, 'HUB data store is not configured')
    items = []
    for row in rows:
        item = dict(row)
        item['definition'] = json.loads(item['definition'])
        items.append(item)
    return {'data':{'items':items}, 'meta':{'source':'hub_data','database':'hmg_analytics',
            'available':bool(total),'page':{'total':total,'limit':limit,'offset':offset}}}
