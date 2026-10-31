from __future__ import annotations
import base64
import os
from aiohttp import ClientSession

class Vision:
    """TypeSafe Jev image API; answers are evidence, never direct room/robot actions."""
    def __init__(self, session: ClientSession):
        self.session = session
        self.key = os.environ.get('TYPESAFE_API_KEY', '')

    async def inspect(self, jpeg: bytes) -> dict:
        if not self.key:
            return {'occupancy': 'unknown', 'floor': 'unknown', 'surfaces': 'unknown', 'confidence': 0.0, 'error': 'Vision provider is not configured. Camera presence does not establish room readiness.'}
        questions = {
            'occupancy': {'type': 'choice', 'instructions': 'Does this office camera frame show a person? Use unknown when people could be hidden or visibility is insufficient.', 'criteria': {'vacant': 'Room visible and no person present', 'occupied': 'At least one person present', 'unknown': 'Insufficient visibility or uncertainty'}},
            'floor': {'type': 'choice', 'instructions': 'Is the visible office floor free of dirt and debris?', 'criteria': {'clean': 'Visible floor is clean', 'dirty': 'Visible dirt or debris', 'unknown': 'Cannot assess floor condition'}},
            'surfaces': {'type': 'choice', 'instructions': 'Are the desk and accessible work surfaces clear of clutter?', 'criteria': {'clear': 'Visible surfaces are clear', 'cluttered': 'Clutter or items need a person to attend', 'unknown': 'Cannot assess surfaces'}},
        }
        body = {'model': os.environ.get('TYPESAFE_MODEL', 'jev-latest'), 'state': {'office_camera': 'odas-frame'}, 'assets': {'odas-frame': {'type': 'image', 'format': 'jpg', 'data_base64': base64.b64encode(jpeg).decode('ascii')}}, 'questions': questions}
        async with self.session.post('https://api.typesafe.ai/v1/systemone', json=body, headers={'Authorization': f'Bearer {self.key}', 'TypeSafe-Danger-Zone-Images': 'true'}, timeout=15) as response:
            if response.status != 200:
                raise ValueError('TypeSafe image inspection request failed')
            answers = (await response.json())['answers']
        result = {}
        confidences = []
        allowed = {'occupancy': {'vacant', 'occupied', 'unknown'}, 'floor': {'clean', 'dirty', 'unknown'}, 'surfaces': {'clear', 'cluttered', 'unknown'}}
        for key, options in allowed.items():
            answer = answers[key]
            if answer.get('type') != 'choice' or answer.get('choice') not in options:
                raise ValueError('Vision answer violated the typed contract')
            confidence = float(answer['confidence'])
            if not 0 <= confidence <= 1:
                raise ValueError('Vision confidence is invalid')
            result[key] = answer['choice']
            confidences.append(confidence)
        result['confidence'] = min(confidences)
        return result
