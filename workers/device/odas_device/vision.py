from __future__ import annotations
import base64
import os
from aiohttp import ClientSession

class VisionError(Exception):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable

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
        stage = os.environ.get('VISION_AREA') == 'stage'
        if stage:
            questions = {
                'occupancy': {'type': 'choice', 'instructions': 'Look only at the raised grey carpeted stage/deck in the foreground, bounded by the left wall and the right edge beside the audience chairs. Is any person on that grey stage? Ignore people seated or standing beyond its right edge in the audience. The robot, furniture, cables, and paper are not people.', 'criteria': {'vacant': 'No person is on the grey stage', 'occupied': 'A person or part of a person is on the grey stage', 'unknown': 'The stage is obscured so presence cannot be determined'}},
                'floor': {'type': 'choice', 'instructions': 'Look only at the grey carpeted stage/deck floor. Is it messy or dirty? Scattered white paper scraps, crumbs, litter, and debris count as dirty. Ignore the robot, fixed furniture, cables, and audience outside the stage.', 'criteria': {'dirty': 'Paper scraps, crumbs, trash or other loose debris are visible on the grey floor', 'clean': 'No loose debris is visible on the grey floor', 'unknown': 'Cannot see enough of the grey floor to assess'}},
            }
        body = {'model': os.environ.get('TYPESAFE_MODEL', 'jev-latest'), 'state': {'office_camera': 'odas-frame'}, 'assets': {'odas-frame': {'type': 'image', 'format': 'jpg', 'data_base64': base64.b64encode(jpeg).decode('ascii')}}, 'questions': questions}
        async with self.session.post('https://api.typesafe.ai/v1/systemone', json=body, headers={'Authorization': f'Bearer {self.key}', 'TypeSafe-Danger-Zone-Images': 'true'}, timeout=15) as response:
            if response.status in (429, 529):
                raise VisionError('Jev is rate limited or overloaded; retrying after a short delay.', retryable=True)
            if response.status != 200:
                raise VisionError('TypeSafe image inspection request failed.')
            answers = (await response.json())['answers']
        result = {}
        confidences = []
        allowed = {'occupancy': {'vacant', 'occupied', 'unknown'}, 'floor': {'clean', 'dirty', 'unknown'}, 'surfaces': {'clear', 'cluttered', 'unknown'}}
        if stage:
            allowed.pop('surfaces')
            result.update(scope='stage', surfaces='unknown')
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
