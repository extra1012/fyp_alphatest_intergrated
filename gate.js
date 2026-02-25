function drawLabelTexture(scene, text, width = 256, height = 128) {
  const texture = new BABYLON.DynamicTexture('gate-label', { width, height }, scene, false);
  const ctx = texture.getContext();
  ctx.fillStyle = '#0b1222';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.font = '32px Segoe UI';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const sanitized = text.length > 32 ? `${text.slice(0, 29)}...` : text;
  texture.drawText(sanitized, width / 2, height / 2, '32px Segoe UI', '#ffffff', '#0b1222', true, true);
  return texture;
}

export function createGate(scene, player, options) {
  const {
    label,
    position,
    color = new BABYLON.Color3(0.29, 0.49, 0.92),
    width = 4,
    height = 4,
    depth = 0.9,
    panelAlpha = 0.9,
    hideVisuals = false,
    onEnter,
    metadata = {},
  } = options;
  const root = new BABYLON.TransformNode('gate-root', scene);
  root.position = position.clone();
  root.metadata = { ...metadata, hit: false };

  const postHeight = 5;
  const postThickness = 0.25;
  const panelHeight = 3.2;
  const panelWidth = Math.max(0.5, width - postThickness);
  const postOffset = width / 2;

  const postMat = new BABYLON.StandardMaterial('gate-post-mat', scene);
  postMat.diffuseColor = new BABYLON.Color3(0.12, 0.15, 0.2);
  postMat.emissiveColor = new BABYLON.Color3(0.04, 0.05, 0.07);

  const panelMat = new BABYLON.StandardMaterial('gate-panel-mat', scene);
  panelMat.diffuseColor = color;
  panelMat.emissiveColor = color.scale(0.4);
  panelMat.alpha = panelAlpha;

  const panel = BABYLON.MeshBuilder.CreateBox(
    'gate-panel',
    { width: panelWidth, height: panelHeight, depth },
    scene
  );
  panel.material = panelMat;
  panel.parent = root;
  panel.position = new BABYLON.Vector3(0, postHeight / 2 + 0.2, 0);
  root.metadata.panelMat = panelMat;

  const leftPost = BABYLON.MeshBuilder.CreateBox(
    'gate-post-left',
    { width: postThickness, height: postHeight, depth: postThickness },
    scene
  );
  leftPost.material = postMat;
  leftPost.parent = root;
  leftPost.position = new BABYLON.Vector3(-postOffset, postHeight / 2, 0);

  const rightPost = leftPost.clone('gate-post-right');
  rightPost.position.x = postOffset;
  rightPost.parent = root;

  const labelTexture = drawLabelTexture(scene, label, 256, 128);
  const labelPlane = BABYLON.MeshBuilder.CreatePlane('gate-label-plane', { size: panelHeight * 0.9, width: panelWidth * 0.9 }, scene);
  const labelMat = new BABYLON.StandardMaterial('gate-label-mat', scene);
  labelMat.diffuseTexture = labelTexture;
  labelMat.diffuseTexture.hasAlpha = true;
  labelMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
  labelMat.backFaceCulling = false;
  labelPlane.material = labelMat;
  labelPlane.parent = root;
  labelPlane.position = new BABYLON.Vector3(0, postHeight / 2, depth / 1.6);

  // Cap topper to mimic mobile-runner gates
  const cap = BABYLON.MeshBuilder.CreateBox('gate-cap', { width: panelWidth, height: 0.35, depth: depth * 1.2 }, scene);
  const capMat = new BABYLON.StandardMaterial('gate-cap-mat', scene);
  capMat.diffuseColor = color.scale(0.9);
  capMat.emissiveColor = color.scale(0.45);
  cap.material = capMat;
  cap.parent = root;
  cap.position = new BABYLON.Vector3(0, postHeight + 0.1, 0);

  if (hideVisuals) {
    panel.isVisible = false;
    leftPost.isVisible = false;
    rightPost.isVisible = false;
    cap.isVisible = false;
    labelPlane.isVisible = false;
  }

  // Invisible collider box to reliably detect intersections
  const collider = BABYLON.MeshBuilder.CreateBox(
    'gate-collider',
    {
      width: width + 0.6, // slightly wider to catch glancing hits
      height: postHeight + 0.5,
      depth: Math.max(depth * 2, 3), // deeper hit box for fast-moving player
    },
    scene
  );
  collider.isVisible = false;
  collider.isPickable = true; // keep pickable so intersection triggers fire
  collider.parent = root;
  collider.position = new BABYLON.Vector3(0, postHeight / 2, 0);
  root.metadata.collider = collider;

  collider.actionManager = new BABYLON.ActionManager(scene);
  collider.actionManager.registerAction(
    new BABYLON.ExecuteCodeAction(
      { trigger: BABYLON.ActionManager.OnIntersectionEnterTrigger, parameter: player },
      () => {
        if (root.metadata.hit) return;
        root.metadata.hit = true;
        if (typeof onEnter === 'function') {
          onEnter(root);
        }
      }
    )
  );

  return root;
}

export function createEndGate(scene, player, position, onEnter) {
  return createGate(scene, player, {
    label: 'Submit Feedback',
    position,
    color: new BABYLON.Color3(0.96, 0.62, 0.11),
    width: 6,
    height: 3.2,
    depth: 1,
    onEnter,
    metadata: { type: 'end' },
  });
}
