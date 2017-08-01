"use strict";

class FramesManager {
  constructor() {
    this.frames = {
      totalFrames: () => { return 0; }
    };
    this.onReset = [];
  }

  set(frames) {
    this.frames = frames;
    for (let i = 0; i < this.onReset.length; i++) {
      this.onReset[i]();
    }
  }
}

function blobToImage(blob) {
  return new Promise((result, _) => {
    let img = new Image();
    img.onload = function() {
      result(img);
      URL.revokeObjectURL(this.src);
    };
    img.src = URL.createObjectURL(blob);
  });
}

/**
 * Extracts the frame sequence of a video file.
 */
function extractFramesFromVideo(config, file, progress) {
  let resolve = null;
  let db = null;
  let video = document.createElement('video');
  let canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d');
  let dimensionsInitialized = false;
  let totalFrames = 0;
  let processedFrames = 0;
  let lastApproxFrame = -1;
  let lastProgressFrame = -1;
  let attachmentName = 'img' + config.imageExtension;

  return new Promise((_resolve, _) => {
    resolve = _resolve;

    let dbName = 'vatic_js';
    db = new PouchDB(dbName).destroy().then(() => {
      db = new PouchDB(dbName);

      video.autoplay = false;
      video.muted = true;
      video.loop = false;
      video.playbackRate = config.playbackRate;
      video.src = URL.createObjectURL(file);
      compatibility.requestAnimationFrame(onBrowserAnimationFrame);
      video.play();
    });
  });

  function onBrowserAnimationFrame() {
    if (dimensionsInitialized && video.ended) {
      if (processedFrames == totalFrames) {
        videoEnded();
      }
      return;
    }

    compatibility.requestAnimationFrame(onBrowserAnimationFrame);

    if (video.readyState !== video.HAVE_CURRENT_DATA &&
        video.readyState !== video.HAVE_FUTURE_DATA &&
        video.readyState !== video.HAVE_ENOUGH_DATA) {
      return;
    }

    let currentApproxFrame = Math.round(video.currentTime * config.fps);
    if (currentApproxFrame != lastApproxFrame) {
      lastApproxFrame = currentApproxFrame;
      let frameNumber = totalFrames;
      totalFrames++;

      if (!dimensionsInitialized) {
        dimensionsInitialized = true;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      ctx.drawImage(video, 0, 0);
      canvas.toBlob(
        (blob) => {
          db.putAttachment(frameNumber.toString(), attachmentName, blob, config.imageMimeType).then((doc) => {
            processedFrames++;

            if (frameNumber > lastProgressFrame) {
              lastProgressFrame = frameNumber;
              progress(video.currentTime / video.duration, processedFrames, blob);
            }

            if (video.ended && processedFrames == totalFrames) {
              videoEnded();
            }
          });
        },
        config.imageMimeType);
    }
  }

  function videoEnded() {
    if (video.src != '') {
      URL.revokeObjectURL(video.src);
      video.src = '';

      resolve({
        totalFrames: () => { return totalFrames; },
        getFrame: (frameNumber) => {
          return db.getAttachment(frameNumber.toString(), attachmentName);
        }
      });
    }
  }
}

/**
 * Extracts the frame sequence from a previously generated zip file.
 */
function extractFramesFromZip(config, file) {
  return new Promise((resolve, _) => {
    JSZip
      .loadAsync(file)
      .then((zip) => {
        let totalFrames = 0;
        for (let i = 0; ; i++) {
          let file = zip.file(i + config.imageExtension);
          if (file == null) {
            totalFrames = i;
            break;
          }
        }

        resolve({
          totalFrames: () => { return totalFrames; },
          getFrame: (frameNumber) => {
            return new Promise((resolve, _) => {
              let file = zip.file(frameNumber + config.imageExtension);
              file
                .async('arraybuffer')
                .then((content) => {
                  let blob = new Blob([ content ], {type: config.imageMimeType});
                  resolve(blob);
                });
            });
          }
        });
      });
  });
}


/**
 * Represents the coordinates of a bounding box
 */
class BoundingBox {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
}

/**
 * Represents a bounding box at a particular frame.
 */
class AnnotatedFrame {
  constructor(frameNumber, bbox, isGroundTruth) {
    this.frameNumber = frameNumber;
    this.bbox = bbox;
    this.isGroundTruth = isGroundTruth;
  }

  isVisible() {
    return this.bbox != null;
  }
}

/**
 * Represents an object bounding boxes throughout the entire frame sequence.
 */
class AnnotatedObject {
  constructor() {
    this.frames = [];
  }

  add(frame) {
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i].frameNumber == frame.frameNumber) {
        this.frames[i] = frame;
				this.removeFramesToBeRecomputed(i);
        return;
			} else if (this.frames[i].frameNumber > frame.frameNumber) {
        this.frames.splice(i, 0, frame);
				this.removeFramesToBeRecomputed(i);
        return;
      }
    }

    this.frames.push(frame);
		if (frame.isGroundTruth == true) {
			this.removeFramesToBeRecomputed(this.frames.length - 1);
		}
  }

  get(frameNumber) {
		return new Promise((resolve, _) => {
			this.interpolate(frameNumber).then((currentFrame) => {
				resolve(currentFrame);
			});
		});
  }
	
	interpolate(frameNumber) {
		return new Promise((resolve, _) => {
			let preGT = -1;
			let nextGT = -1;
			let current = -1;
			for (let i = 0; i < this.frames.length; i++) {
				if (this.frames[i].frameNumber == frameNumber) {
					resolve(this.frames[i]);
				}
				if ( (current < 0) && (this.frames[i].frameNumber > frameNumber) ) {
					current = i;
				}
				if (this.frames[i].isGroundTruth) {
					if (this.frames[i].frameNumber < frameNumber) {
						preGT = i;
					} else {
						nextGT = i;
						break;
					}
				}
			}
			
			if (current < 0) {
				let currentBbox = this.frames[preGT].bbox;
				if (currentBbox == null) {
					this.frames.push(new AnnotatedFrame(frameNumber, null, false));
				} else {
					let bbox = new BoundingBox(currentBbox.x, currentBbox.y, currentBbox.width, currentBbox.height);
					this.frames.push(new AnnotatedFrame(frameNumber, bbox, false));
				}
				resolve(this.frames[this.frames.length - 1]);
			} else {
				if (preGT < 0) {
					this.frames.splice(current, 0, new AnnotatedFrame(frameNumber, null, false));
				} else if (nextGT < 0) {
					let currentBbox = this.frames[preGT].bbox;
					if (currentBbox == null) {
						this.frames.splice(current, 0, new AnnotatedFrame(frameNumber, null, false));
					} else {
						let bbox = new BoundingBox(currentBbox.x, currentBbox.y, currentBbox.width, currentBbox.height);
						this.frames.splice(current, 0, new AnnotatedFrame(frameNumber, bbox, false));
					}
				} else {
					let interval = this.frames[nextGT].frameNumber - this.frames[preGT].frameNumber;
					let stride = frameNumber - this.frames[preGT].frameNumber;
					let startBbox = this.frames[preGT].bbox;
					let endBbox = this.frames[nextGT].bbox;
					if ( (startBbox == null) && (endBbox == null) ) {
						this.frames.splice(current, 0, new AnnotatedFrame(frameNumber, null, false));
					} else if (endBbox == null) {
						let bbox = new BoundingBox(startBbox.x, startBbox.y, startBbox.width, startBbox.height);
						this.frames.splice(current, 0, new AnnotatedFrame(frameNumber, bbox, false));
					} else if (startBbox == null) {
						let bbox = new BoundingBox(endBbox.x, endBbox.y, endBbox.width, endBbox.height);
						this.frames.splice(current, 0, new AnnotatedFrame(frameNumber, bbox, false));
					} else {
						let newX = startBbox.x + Math.round(stride * (endBbox.x - startBbox.x) / interval);
						let newY = startBbox.y + Math.round(stride * (endBbox.y - startBbox.y) / interval);
						let newWidth = startBbox.width + Math.round(stride * (endBbox.width - startBbox.width) / interval);
						let newHeight = startBbox.height + Math.round(stride * (endBbox.height - startBbox.height) / interval);
						let bbox = new BoundingBox(newX, newY, newWidth, newHeight);
						this.frames.splice(current, 0, new AnnotatedFrame(frameNumber, bbox, false));
					}
				}
				resolve(this.frames[current]);
			}
		});
	}
	removeFramesToBeRecomputed(frameNumber) {
		let count = 0;
		for (let i = frameNumber + 1; i < this.frames.length; i++) {
			if (this.frames[i].isGroundTruth) {
				break;
			}
			count++;
		}
		if (count > 0) {
			this.frames.splice(frameNumber, count);
		}
		
		count = 0;
		for (let i = frameNumber - 1; i >= 0; i--) {
			if (this.frames[i].isGroundTruth) {
				break;
			}
			count++;
		}
		if (count > 0) {
			this.frames.splice(frameNumber - count, count);
		}
	}
}

/**
 * Tracks annotated objects throughout a frame sequence using optical flow.
 */
class AnnotatedObjectsTracker {
  constructor(framesManager) {
    this.framesManager = framesManager;
    this.annotatedObjects = [];
    this.lastFrame = -1;
    this.ctx = document.createElement('canvas').getContext('2d');

    this.framesManager.onReset.push(() => {
      this.annotatedObjects = [];
      this.lastFrame = -1;
    });
  }

  getFrameWithObjects(frameNumber) {
    return new Promise((resolve, _) => {
			this.framesManager.frames.getFrame(frameNumber).then((blob) => {
				blobToImage(blob).then((img) => {
					let result = [];
					let i = 0;
					let getFrames = (result) => {
						if (i >= this.annotatedObjects.length) {
							resolve({img: img, objects: result});
						} else {
							let annotatedObject = this.annotatedObjects[i];
							annotatedObject.get(frameNumber).then((annotatedFrame) => {
								result.push({annotatedObject: annotatedObject, annotatedFrame: annotatedFrame});
								i++
								getFrames(result);
							});
						}
					};
					
					getFrames(result);
				});
			});
			
    });
  }
	
	getResult(frameNumber) {
		return new Promise((resolve, _) => {
			let result = [];
			for (let i = 0; i < this.annotatedObjects.length; i++) {
				let annotatedOannotatedObject = annotatedObjects[i];
				annotatedObject.get(frameNumber).then((annotatedFrame) => {
					if (annotatedFrame != null) {
						result.push({annotatedObject: annotatedObject, annotatedFrame: annotatedFrame});
					}
				});
			}
			resolve(result);
		});
	}
  imageData(img) {
    let canvas = this.ctx.canvas;
    canvas.width = img.width;
    canvas.height = img.height;
    this.ctx.drawImage(img, 0, 0);
    return this.ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
};
