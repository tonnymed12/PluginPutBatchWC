sap.ui.define([
    'jquery.sap.global',
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/ui/model/json/JSONModel",
    "./Utils/Commons",
    "./Utils/ApiPaths",
    "../model/formatter",
    "sap/ui/core/Element",
    "sap/m/MessageBox",
], function (jQuery, PluginViewController, JSONModel, Commons, ApiPaths, formatter, Element, MessageBox) {
    "use strict";

    var gOperationPhase = {};
    const OPERATION_STATUS = { ACTIVE: "ACTIVE", QUEUED: "IN_QUEUE" }

    return PluginViewController.extend("serviacero.custom.plugins.zpluginPutBatchWC.zpluginPutBatchWC.controller.MainView", {
        Commons: Commons,
        ApiPaths: ApiPaths,
        formatter: formatter,

        onInit: function () {
            PluginViewController.prototype.onInit.apply(this, arguments);
            this.oScanInput = this.byId("scanInput");
            this.iSecuenciaCounter = 0;  // Contador de secuencia para cada escaneo

        },
        onAfterRendering: function () {
            this.onGetCustomValues();
        },
        onGetCustomValues: function () {
            const oView = this.getView(),
                oSapApi = this.Commons.getSapApiPath(this),
                oTable = oView.byId("idSlotTable"),
                oPODParams = this.Commons.getPODParams(this.getOwnerComponent()),

                sUri = oSapApi + this.ApiPaths.WORKCENTERS,

                oParams = {
                    plant: oPODParams.PLANT_ID,
                    workCenter: oPODParams.WORK_CENTER
                };

            this.Commons.consumeApi(sUri, "GET", oParams, function (oRes) {
                // Tomamos el primer objeto del array
                const oData = Array.isArray(oRes) ? oRes[0] : oRes;

                if (!oData || !oData.customValues) {
                    console.error("No se encontraron customValues en la respuesta");
                    return;
                }

                const aCustomValues = oData.customValues;

                const cantidadSlot = aCustomValues.find((element) => element.attribute == "SLOTQTY");
                const tipoSlot = aCustomValues.find((element) => element.attribute == "SLOTTIPO");
                const aSlots = aCustomValues.filter(item =>
                    item.attribute.startsWith("SLOT") &&
                    item.attribute !== "SLOTQTY" &&
                    item.attribute !== "SLOTTIPO"
                );

                //  Rellenar slots faltantes según SLOTQTY
                const iSlotQty = parseInt(cantidadSlot?.value || "0", 10);
                let aSlotsFixed = [...aSlots];

                // Caso 1 :hay más slots con valor que los permitidos -> eliminar y actualizar en vacio
                if (aSlotsFixed.length > iSlotQty) {
                    // Nos quedamos solo con los primeros 
                    aSlotsFixed = aSlotsFixed.slice(0, iSlotQty);

                    // Los que se eliminaron, hay que vaciarlos en el update
                    const aSobran = aSlots.slice(iSlotQty);
                    aSobran.forEach(slot => {
                        slot.value = "";  // se vacían para mandar update
                    });

                    // Mandar update inmediato para limpiar los sobrantes
                    const oParamsUpdate = {
                        inCustomValues: aCustomValues.map(item => {
                            // si está en los que sobran, value vacío
                            const sobrante = aSobran.find(s => s.attribute === item.attribute);
                            return sobrante ? { attribute: item.attribute, value: "" } : item;
                        }),
                        inPlant: oPODParams.PLANT_ID,
                        inWorkCenter: oPODParams.WORK_CENTER
                    };

                    this.setCustomValuesPp(oParamsUpdate, oSapApi).then(() => {
                        console.log("Lotes sobrantes eliminados correctamente");
                    });
                }
                // Caso 2: hay menos slots que SLOTQTY -> rellenar vacíos
                for (let i = aSlotsFixed.length + 1; i <= iSlotQty; i++) {
                    aSlotsFixed.push({
                        attribute: "SLOT" + i.toString().padStart(3, "0"),
                        value: "" // valor vacío para que después lo puedan llenar
                    });
                }

                // Setear los datos en la tabla
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aSlotsFixed }));

                // Setear los valores en los inputs
                oView.byId("slotQty").setValue(cantidadSlot.value);
                oView.byId("slotType").setValue(tipoSlot.value);

                // Resetear secuencia si no hay slots con valores
                const iSlotTotal = aSlotsFixed.filter(slot => slot.value && slot.value.trim() !== "").length;
                if (iSlotTotal === 0) {
                    this.iSecuenciaCounter = 0;
                }

            }.bind(this));
        },
        onBarcodeSubmit: function () {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            const sBarcode = oInput.getValue().trim();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (!sBarcode) {
                return; // no hacer nada si está vacío
            }

            const oTable = oView.byId("idSlotTable");
            const oModel = oTable.getModel();
            const aItems = oModel.getProperty("/ITEMS") || [];

            const iSlotsConValor = aItems.filter(slot => slot.value && slot.value.trim() !== "").length;
            if (iSlotsConValor === 0) {
                this.iSecuenciaCounter = 0;
            }

            //comparacion del lote ingresado 
            const sNormalizado = sBarcode.toUpperCase();
            //busca si es igual a uno de los items 
            const oExiste = aItems.find(Item => {
                return (Item.value || "").toString().trim().toUpperCase() === sNormalizado;
            });

            //LOGICA DE VALIDACION-------------------------------------------------------

            const partsBarcode = sNormalizado.split('!');

            if (partsBarcode.length < 2 || !partsBarcode[0] || !partsBarcode[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                oInput.setValue(""); oInput.focus();
                return;
            }
            const loteExtraido = partsBarcode[1].trim();
            const materialExtraido = partsBarcode[0].trim();

            this._validarMaterialYLote(loteExtraido, materialExtraido);

        },
        onPressClear: function () {
            const oView = this.getView(),
                oResBun = oView.getModel("i18n").getResourceBundle();
            this.Commons.showConfirmDialog(function () {
                this.clearModel();
            }.bind(this), null, oResBun.getText("clearWarningMessage"));
        },
        clearModel: function () {
            const oView = this.getView();
            const oTable = oView.byId("idSlotTable");
            const oScanInput = oView.byId("scanInput");
            const oModel = oTable.getModel();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            //obtener el modelo actual de la tabla 
            const aItems = oModel.getProperty("/ITEMS") || [];
            console.log("ITEMS DEL MODELO ACTUAL:", aItems)
            if (aItems.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("noDataToClear"));
                return;
            }
            //vaciar los valores manteniendo el attributo
            aItems.forEach(item => {
                item.value = "";  //se vacia solo el valor 
            });

            //se acctualiza el modelo de la vista
            oModel.setProperty("/ITEMS", aItems);
            oModel.refresh(true);
            oScanInput.setValue("");
            oScanInput.focus();

            // Resetear secuencia cuando se limpian los datos
            this.iSecuenciaCounter = 0;

            //se prepara los datos para hacer el update 
            const slotTipo = oView.byId("slotType").getValue();
            const slotQty = oView.byId("slotQty").getValue();

            const aEdited = [
                { attribute: "SLOTTIPO", value: slotTipo },
                { attribute: "SLOTQTY", value: slotQty },
                ...aItems.map(slot => ({ attribute: slot.attribute, value: slot.value }))
            ]

            // Llama a la API para obtener los originales
            const oSapApi = this.Commons.getSapApiPath(this);
            const sParams = {
                plant: oPODParams.PLANT_ID,
                workCenter: oPODParams.WORK_CENTER
            };
            //llamado a la API 
            this.getWorkCenterCustomValues(sParams, oSapApi).then(oOriginalRes => {
                const aOriginal = oOriginalRes.customValues || [];
                const aEditMap = {};

                //se crea el mapa de los valores editados (los vacioos)
                aEdited.forEach(item => {
                    aEditMap[item.attribute] = item.value;  //-----------------------------------------------------------------------------
                })
                //combinar los originales con los editados
                const aCustomValuesFinal = aOriginal.map(item => ({
                    attribute: item.attribute,
                    value: aEditMap.hasOwnProperty(item.attribute) ? aEditMap[item.attribute] : item.value
                }));
                // Agregar los que no estaban en el original, los nuevos en este caso los vacios 
                for (const key in aEditMap) {
                    if (!aCustomValuesFinal.find(i => i.attribute === key)) {
                        aCustomValuesFinal.push({ attribute: key, value: aEditMap[key] });
                    }
                }
                //llamar al pp para actualizar los customValues de WC
                console.log(aCustomValuesFinal);
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER
                }, oSapApi).then(() => {
                    sap.m.MessageToast.show(oBundle.getText("dataClearedSuccess"));
                    // sap.m.MessageToast.show("Lote actualizado correctamente");
                }).catch(() => {
                    sap.m.MessageToast.show(oBundle.getText("errorClearing"));
                    // En caso de error, recargar los datos originales
                    this.onGetCustomValues();
                });
            }).catch(() => {
                sap.m.MessageToast.show("Error al obtener datos originales");
            });

        },
        /**
        * Llamada al Pp(getReservas) para obtener los lotes en Reserva y hacer validacion de material
        * @param {string} sLote - Valor del lote "material!lote" 
        * @param {string} sMaterial - Valor del material "material!lote" 
        * @returns {string} - Solo el material
        */
        _validarMaterialYLote: function (sLote, sMaterial) {
            const oView = this.getView();
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const mandante = this.getConfiguration().mandante;
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oInput = oView.byId("scanInput");
            const loteEscaneado = sLote;
            const materialEscaneado = sMaterial;

            if (gOperationPhase.status !== OPERATION_STATUS.ACTIVE) {
                sap.m.MessageBox.error(oBundle.getText("verificarStatusOperacion"))
                return;
            }

            // validacion de material
            const urlMaterial = this.getPublicApiRestDataSourceUri() + this.ApiPaths.validateMaterialEnOrden;
            var inParamsMaterial = {
                "inPlanta": oPODParams.PLANT_ID,
                "inLote": loteEscaneado,
                "inOrden": oPODParams.ORDER_ID,
                "inMaterial": materialEscaneado
            };
            oView.byId("idPluginPanel").setBusy(true);

            this.ajaxPostRequest(urlMaterial, inParamsMaterial,
                // SUCCESS callback de validación de material
                function (oResMat) {
                    console.log("Respuesta material:", oResMat);
                    const matOk = oResMat && (oResMat.outMaterial === true || oResMat.outMaterial === "true");
                    const msgMat = (oResMat && oResMat.outMensaje) || oBundle.getText("materialNoValido");

                    if (!matOk) {
                        oView.byId("idPluginPanel").setBusy(false);
                        sap.m.MessageToast.show(msgMat);
                        oInput.setValue("");
                        oInput.focus();
                        return;
                    }

                    //Validacion de lotes  
                    var urlLote = this.getPublicApiRestDataSourceUri() + this.ApiPaths.getReservas;
                    var inParamsLote = {
                        "inPlanta": oPODParams.PLANT_ID,
                        "inLote": loteEscaneado,
                        "inOrden": oPODParams.ORDER_ID,
                        "inSapClient": mandante,
                        "inMaterial": materialEscaneado,
                        "inPuesto": oPODParams.WORK_CENTER
                    };

                    this.ajaxPostRequest(urlLote, inParamsLote,
                        // SUCCESS callback de validación de lote
                        function (oResponseData) {
                            oView.byId("idPluginPanel").setBusy(false);
                            console.log("Respuesta lote:", oResponseData);

                            var bEsValido = false;
                            if (oResponseData.outLote === "true" || oResponseData.outLote === true) {
                                bEsValido = true;
                            } else if (oResponseData.outLote === "false" || oResponseData.outLote === false) {
                                bEsValido = false;
                            }

                            if (bEsValido) {
                                // Detectar de dónde vino el escaneo
                                if (!this._slotContext) {
                                    // Viene del input superior → buscar slot vacío
                                    this._ejecutarUpdate();
                                } else {
                                    // Viene del botón por fila → actualizar ese slot
                                    this._procesarSlotValidado();
                                }
                            } else {
                                sap.m.MessageToast.show(oBundle.getText("loteNoValido"));
                                // Solo limpiar input si viene del input superior
                                if (!this._slotContext) {
                                    oInput.setValue("");
                                    oInput.focus();
                                }
                                // Limpiar contexto siempre
                                this._slotContext = null;
                            }
                        }.bind(this),
                        // ERROR callback de validación de lote
                        function (oError, sHttpErrorMessage) {
                            oView.byId("idPluginPanel").setBusy(false);
                            var err = oError || sHttpErrorMessage;
                            sap.m.MessageToast.show("Error al validar lote " + err);

                            // Solo limpiar input si viene del input superior
                            if (!this._slotContext) {
                                oInput.setValue("");
                                oInput.focus();
                            }
                            // Limpiar contexto siempre
                            this._slotContext = null;
                        }.bind(this)
                    );
                }.bind(this),
                // ERROR callback de validación de material
                function (oError, sHttpErrorMessage) {
                    oView.byId("idPluginPanel").setBusy(false);
                    sap.m.MessageToast.show(oBundle.getText("errorValidacion") || ("Error validación material: " + (sHttpErrorMessage || "")));
                    // Solo limpiar input si viene del input superior
                    if (!this._slotContext) {
                        oInput.setValue("");
                        oInput.focus();
                    }
                    // Limpiar contexto siempre
                    this._slotContext = null;
                }.bind(this)
            );
        },
        _ejecutarUpdate: function () {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            const sBarcode = oInput.getValue().trim();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oBundle = oView.getModel("i18n").getResourceBundle();

            const oTable = oView.byId("idSlotTable");
            const oModel = oTable.getModel();
            const aItems = oModel.getProperty("/ITEMS") || [];

            // Extraer material!lote del barcode escaneado (ignorar secuencia si existe)
            const sNormalizado = sBarcode.toUpperCase();
            const partsEscaneado = sNormalizado.split('!');
            const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!'); // solo material!lote

            // Buscar si ya existe un item con el mismo material!lote
            const oExiste = aItems.find(Item => {
                const valorItem = (Item.value || "").toString().trim().toUpperCase();
                if (!valorItem) return false;
                
                const partsItem = valorItem.split('!');
                const materialLoteItem = partsItem.slice(0, 2).join('!'); // solo material!lote
                
                return materialLoteItem === materialLoteEscaneado;
            });

            if (oExiste) {
                sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, oExiste.attribute]))
                oInput.setValue("");
                oInput.focus();
                return;
            }

            // Buscar el primer slot vacío
            const oEmptySlot = aItems.find(item => !item.value || item.value === "");

            if (oEmptySlot) {
                // Incrementar secuencia y concatenar al barcode
                this.iSecuenciaCounter++;
                oEmptySlot.value = sBarcode + "!" + this.iSecuenciaCounter; // asignar valor con secuencia
                oModel.refresh(true);        // refrescar la tabla
            } else {
                sap.m.MessageToast.show(oBundle.getText("sinLotes"));
                return;
                // sap.m.MessageToast.show("No hay lotes por llenar");
            }

            // Limpiar input y darle foco de nuevo
            oInput.setValue("");
            oInput.focus();

            const slotTipo = oView.byId("slotType").getValue();
            const slotQty = oView.byId("slotQty").getValue();

            // editados
            const aEdited = [
                { attribute: "SLOTTIPO", value: slotTipo },
                { attribute: "SLOTQTY", value: slotQty },
                ...aItems.map(slot => ({ attribute: slot.attribute, value: slot.value }))
            ];

            const oSapApi = this.Commons.getSapApiPath(this);
            const sParams = { plant: oPODParams.PLANT_ID, workCenter: oPODParams.WORK_CENTER };

            // trae los customValues originales
            this.getWorkCenterCustomValues(sParams, oSapApi).then(oOriginalRes => {
                const aOriginal = oOriginalRes.customValues || [];

                // combina los custom originales + editados
                const editedMap = {};
                aEdited.forEach(item => { editedMap[item.attribute] = item.value; });

                const aCustomValuesFinal = aOriginal.map(item => ({
                    attribute: item.attribute,
                    value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                }));

                // Agregar los que no estaban en el original
                for (const key in editedMap) {
                    if (!aCustomValuesFinal.find(i => i.attribute === key)) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }
                console.log("Custom Values Final:", aCustomValuesFinal);
                // Update inmediato
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER
                }, oSapApi).then(() => {
                    sap.m.MessageToast.show(oBundle.getText("slotActualizado"));

                    // sap.m.MessageToast.show("Slot actualizado correctamente");
                }).catch(() => {
                    sap.m.MessageToast.show(oBundle.getText("errorActualizarSlot"));
                    // sap.m.MessageBox.error("Error al actualizar los slots");
                });
            });
        },
        onScanSuccess: function (oEvent) {
            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show("Scan cancelled", { duration: 1000 });
            } else {
                if (oEvent.getParameter("text")) {
                    this.oScanInput.setValue(oEvent.getParameter("text"));
                    this.onBarcodeSubmit();
                } else {
                    this.oScanInput.setValue('');
                }
            }
        },
        onScanError: function (oEvent) {
            sap.m.MessageToast.show("Scan failed: " + oEvent, { duration: 1000 });
        },
        onScanLiveupdate: function (oEvent) {
            // User can implement the validation about inputting value
        },
        //funcion del boton #Eliminar-delete elimina un elemento de la 
        onDeleteSlot: function (oEvent) {
            const oView = this.getView();
            const oTable = this.byId("idSlotTable");
            const oModel = oTable.getModel();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            let aSlots = oModel.getProperty("/ITEMS");
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            // Ubica el índice de la fila seleccionada
            const oItem = oEvent.getSource().getParent(); // el <ColumnListItem>
            const iIndex = oTable.indexOfItem(oItem);

            if (iIndex === -1) {
                return;
            }

            // Elimina el valor de ese slot y recorrer los siguientes hacia arriba
            for (let i = iIndex; i < aSlots.length - 1; i++) {
                aSlots[i].value = aSlots[i + 1].value; // mover valor del siguiente
            }

            // Vacia el último slot
            aSlots[aSlots.length - 1].value = "";

            // Actualiza el modelo
            oModel.setProperty("/ITEMS", aSlots);
            oModel.refresh(true);

            sap.m.MessageToast.show(oBundle.getText("loteEliminado"));
            // sap.m.MessageToast.show("Lote eliminado correctamente");

            // parte del update inmediato
            const slotTipo = oView.byId("slotType").getValue();
            const slotQty = oView.byId("slotQty").getValue();

            const aEdited = [
                { attribute: "SLOTTIPO", value: slotTipo },
                { attribute: "SLOTQTY", value: slotQty },
                ...aSlots.map(slot => ({ attribute: slot.attribute, value: slot.value }))
            ];

            const oSapApi = this.Commons.getSapApiPath(this);
            const sParams = { plant: oPODParams.PLANT_ID, workCenter: oPODParams.WORK_CENTER };

            this.getWorkCenterCustomValues(sParams, oSapApi).then(oOriginalRes => {
                const aOriginal = oOriginalRes.customValues || [];
                const editedMap = {};
                aEdited.forEach(item => { editedMap[item.attribute] = item.value; });

                const aCustomValuesFinal = aOriginal.map(item => ({
                    attribute: item.attribute,
                    value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                }));

                // agrega los que no estaban en el original
                for (const key in editedMap) {
                    if (!aCustomValuesFinal.find(i => i.attribute === key)) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }

                // Enviar a la API
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER
                }, oSapApi).then(() => {
                    sap.m.MessageToast.show(oBundle.getText("loteActualizadoAntesEliminar"));
                    // sap.m.MessageToast.show("Lotes actualizados después de eliminar.");
                }).catch(() => {
                    sap.m.MessageBox.error("Error al actualizar tras eliminar");
                });
            });
        },
        //
        onScanSlotSuccess: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show("Scan cancelled", { duration: 1000 });
                return;
            }
            const sBarcode = (oEvent.getParameter("text") || "").trim();
            if (!sBarcode) { return; }

            const parts = sBarcode.toUpperCase().split('!');
            if (parts.length < 2 || !parts[0] || !parts[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                return;
            }

            const sMaterial = parts[0].trim();
            const sLote = parts[1].trim();

            // Guarda contexto para actualizar la fila cuando ambas validaciones pasen
            this._slotContext = { oEvent, sBarcode, loteExtraido: sLote };

            // Reutiliza la validación combinada
            this._validarMaterialYLote(sLote, sMaterial);
        },
        /**
         * Validar lote para slot específico
         */
        _procesarSlotValidado: function () {
            if (!this._slotContext) {
                console.error("No hay contexto de slot guardado");
                return;
            }

            const { oEvent, sBarcode, loteExtraido } = this._slotContext;
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());

            // se obtiene la fila donde se encuentra el botón
            const oButton = oEvent.getSource();
            const oItem = oButton.getParent(); // el <ColumnListItem>

            // obtiene el índice de la fila
            const oTable = this.byId("idSlotTable");
            const iIndex = oTable.indexOfItem(oItem);

            // obtiene el modelo de la tabla
            const oModel = oTable.getModel();
            const aSlots = oModel.getProperty("/ITEMS");
            //por si no encuentra el índice o el lote
            if (iIndex === -1 || !aSlots[iIndex]) {
                return;
            }

            //comparacion del lote ingresado 
            const sNormalizado = sBarcode.toUpperCase();
            
            // Extraer material!lote del barcode escaneado (ignorar secuencia si existe)
            const partsEscaneado = sNormalizado.split('!');
            const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!'); // solo material!lote

            //busca si es igual a uno de los items
            const sExiste = aSlots.find((slot, idx) => {
                if (idx === iIndex) {
                    return false; // ignora el slot actual
                }
                const valorSlot = (slot.value || "").toString().trim().toUpperCase();
                if (!valorSlot) return false;
                
                const partsSlot = valorSlot.split('!');
                const materialLoteSlot = partsSlot.slice(0, 2).join('!'); // solo material!lote
                
                return materialLoteSlot === materialLoteEscaneado;
            });

            if (sExiste) {
                sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, sExiste.attribute]));
                return;
            }
            
            // Si el valor ya es el mismo en esa fila, no actualizar
            const valorActual = (aSlots[iIndex].value || "").toString().trim().toUpperCase();
            if (valorActual) {
                const partsActual = valorActual.split('!');
                const materialLoteActual = partsActual.slice(0, 2).join('!');
                
                if (materialLoteActual === materialLoteEscaneado) {
                    sap.m.MessageToast.show(oBundle.getText("sinCambios"));
                    return;
                }
            }

            const iSlotsConValor = aSlots.filter(slot => slot.value && slot.value.trim() !== "").length;
            if (iSlotsConValor === 0) {
                this.iSecuenciaCounter = 0;
            }

            // Incrementar secuencia y asigna el código escaneado al slot correspondiente
            this.iSecuenciaCounter++;
            aSlots[iIndex].value = sBarcode + "!" + this.iSecuenciaCounter;
            oModel.setProperty("/ITEMS", aSlots);
            oModel.refresh(true);

            // Inputs
            const oView = this.getView();
            const slotTipo = oView.byId("slotType").getValue();
            const slotQty = oView.byId("slotQty").getValue();

            // Editados
            const aEdited = [
                { attribute: "SLOTTIPO", value: slotTipo },
                { attribute: "SLOTQTY", value: slotQty },
                ...aSlots.map(slot => ({ attribute: slot.attribute, value: slot.value }))
            ];

            const oSapApi = this.Commons.getSapApiPath(this);
            const sParams = { plant: oPODParams.PLANT_ID, workCenter: oPODParams.WORK_CENTER };

            // Traer originales y combinar
            this.getWorkCenterCustomValues(sParams, oSapApi).then(oOriginalRes => {
                const aOriginal = oOriginalRes.customValues || [];
                const editedMap = {};
                aEdited.forEach(item => { editedMap[item.attribute] = item.value; });

                const aCustomValuesFinal = aOriginal.map(item => ({
                    attribute: item.attribute,
                    value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                }));

                for (const key in editedMap) {
                    if (!aCustomValuesFinal.find(i => i.attribute === key)) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }
                console.log(aCustomValuesFinal);
                this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER
                }, oSapApi).then(() => {
                    sap.m.MessageToast.show(oBundle.getText("slotActualizado"));
                    this._slotContext = null;
                }).catch(() => {
                    sap.m.MessageToast.show(oBundle.getText("errorActualizar"));
                    this._slotContext = null;
                });
            });

        },
        onBeforeRenderingPlugin: function () {
            this.subscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);

        },
        onPhaseSelectionEventCustom: function (sChannelId, sEventId, oData) {
            if (this.isEventFiredByThisPlugin(oData)) {
                return;
            }
            gOperationPhase = oData;
            this.onGetCustomValues();


        },
        isSubscribingToNotifications: function () {
            var bNotificationsEnabled = true;
            return bNotificationsEnabled;
        },
        getCustomNotificationEvents: function (sTopic) {
            //return ["template"];
        },
        getNotificationMessageHandler: function (sTopic) {
            //if (sTopic === "template") {
            //    return this._handleNotificationMessage;
            //}
            return null;
        },
        _handleNotificationMessage: function (oMsg) {

            var sMessage = "Message not found in payload 'message' property";
            if (oMsg && oMsg.parameters && oMsg.parameters.length > 0) {
                for (var i = 0; i < oMsg.parameters.length; i++) {

                    switch (oMsg.parameters[i].name) {
                        case "template":

                            break;
                        case "template2":
                    }
                }
            }
        },
        onExit: function () {
            PluginViewController.prototype.onExit.apply(this, arguments);

            this.unsubscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);
        },
        getWorkCenterCustomValues: function (sParams, oSapApi) {
            return new Promise((resolve) => {
                this.Commons.consumeApi(oSapApi + this.ApiPaths.WORKCENTERS, "GET", sParams, function (oRes) {
                    resolve(oRes[0]);
                }.bind(this),
                    function (oRes) {
                        // Error callback
                        this.clearModel();
                        resolve("Error")
                    }.bind(this));
            });
        },
        setCustomValuesPp: function (oParams, oSapApi) {
            return new Promise((resolve) => {
                this.Commons.consumeApi_pp(oSapApi + this.ApiPaths.putBatchSlotWorkCenter, "POST", oParams, function (oRes) {
                    resolve(oRes[0]);
                }.bind(this),
                    function (oRes) {
                        // Error callback
                        this.clearModel();
                        resolve("Error")
                    }.bind(this));
            });
        },
    });
});